package expo.modules.youtubeextractor

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.URI
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

// expo-file-system's DownloadTask has a hardcoded 60s *idle-read* timeout with
// no JS-facing way to raise it, and a single long-lived stream is only as
// reliable as its single weakest stall. YouTube's CDN paces longer files well
// below burst speed, and real 5-7min audio files were observed to hit that
// stall wall while a 29s clip didn't - this is duration-dependent by design,
// not a fluke. Fetching in small Range-bounded chunks means a stall only has
// to be survived within one chunk's own timeout window, and a failed chunk
// can be retried on its own - so total transfer time has no built-in ceiling,
// however long the underlying file actually is.
private const val CHUNK_SIZE = 2L * 1024 * 1024
private const val MAX_ATTEMPTS_PER_CHUNK = 4

private val chunkClient = OkHttpClient.Builder()
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(90, TimeUnit.SECONDS)
    .build()

// isFullBodyFromZero means the server ignored our Range header and sent the
// whole resource back as a plain 200, starting at byte 0 - distinct from a
// well-formed 206 Partial Content response.
private class ChunkResult(val bytesWritten: Long, val reportedTotal: Long?, val isFullBodyFromZero: Boolean)

fun downloadInChunks(url: String, headers: Map<String, String>, destinationPath: String) {
    // destinationPath comes from JS as a `file://` URI (expo-file-system's
    // File.uri format), not a plain filesystem path.
    val destination = File(URI(destinationPath))
    destination.parentFile?.mkdirs()
    if (destination.exists()) destination.delete()

    var start = 0L
    var total = -1L

    RandomAccessFile(destination, "rw").use { raf ->
        while (total < 0 || start < total) {
            val end = if (total < 0) start + CHUNK_SIZE - 1 else minOf(start + CHUNK_SIZE - 1, total - 1)
            // Content-Range is only required while total is still unknown -
            // once we know the real size we don't need it from every chunk.
            val result = fetchChunkWithRetries(url, headers, start, end, raf, needsTotal = total < 0)

            if (result.isFullBodyFromZero) {
                // Server ignored Range entirely and returned the whole file
                // from byte 0. Only valid on the very first request - if it
                // happens mid-download the server is behaving inconsistently
                // and we can't safely reconstruct the file, so fail loudly
                // instead of writing a giant blob at the wrong offset.
                if (start != 0L) {
                    throw IOException("Server stopped honoring Range mid-download at offset $start")
                }
                total = result.bytesWritten
                start = result.bytesWritten
                break
            }

            if (total < 0) {
                total = result.reportedTotal
                    ?: throw IOException("206 response missing a parseable Content-Range header")
            }

            start += result.bytesWritten

            if (result.bytesWritten == 0L) {
                // Nothing left to read and no total was ever reported - avoid
                // spinning forever on a misbehaving server.
                break
            }
        }
    }

    // A truncated file must never reach the decoder silently - see Eco Drive
    // Log 2026-08-22 (Three Findings): a silent partial download here was
    // the root cause of both a decode failure and a language-detect miss.
    val actualSize = destination.length()
    if (actualSize != total) {
        throw IOException("Download incomplete: expected $total bytes, got $actualSize")
    }
}

private fun fetchChunkWithRetries(
    url: String,
    headers: Map<String, String>,
    start: Long,
    end: Long,
    raf: RandomAccessFile,
    needsTotal: Boolean,
): ChunkResult {
    var lastError: Exception? = null

    for (attempt in 1..MAX_ATTEMPTS_PER_CHUNK) {
        try {
            val requestBuilder = Request.Builder().url(url).header("Range", "bytes=$start-$end")
            headers.forEach { (key, value) -> requestBuilder.header(key, value) }

            chunkClient.newCall(requestBuilder.build()).execute().use { response ->
                if (!response.isSuccessful) {
                    throw IOException("HTTP ${response.code}")
                }

                val body = response.body ?: throw IOException("Empty response body")
                val bytes = body.bytes()

                if (response.code == 200) {
                    raf.seek(0)
                    raf.write(bytes)
                    return ChunkResult(bytes.size.toLong(), null, isFullBodyFromZero = true)
                }

                val reportedTotal = parseTotalFromContentRange(response.header("Content-Range"))
                if (needsTotal && reportedTotal == null) {
                    // Malformed/missing header on the response that's supposed to
                    // establish the real total - worth a retry before giving up,
                    // rather than silently guessing a wrong (too-small) total.
                    throw IOException("206 response missing Content-Range while total is still unknown")
                }

                raf.seek(start)
                raf.write(bytes)
                return ChunkResult(bytes.size.toLong(), reportedTotal, isFullBodyFromZero = false)
            }
        } catch (e: Exception) {
            lastError = e
            if (attempt < MAX_ATTEMPTS_PER_CHUNK) {
                Thread.sleep(1000L * attempt)
            }
        }
    }

    throw lastError ?: IOException("Chunk download failed at offset $start")
}

private fun parseTotalFromContentRange(header: String?): Long? {
    // Format: "bytes 0-2097151/123456789"
    val slashIndex = header?.lastIndexOf('/') ?: return null
    if (slashIndex == -1) return null
    return header.substring(slashIndex + 1).toLongOrNull()
}
