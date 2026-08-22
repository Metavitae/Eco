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

private class ChunkResult(val bytesWritten: Long, val reportedTotal: Long?)

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
            val result = fetchChunkWithRetries(url, headers, start, end, raf)

            if (total < 0) {
                // First response determines the real total: either from
                // Content-Range (server honored our Range request), or - if
                // the server ignored Range and sent everything back in one
                // 200 response - the whole file is already written now.
                total = result.reportedTotal ?: (start + result.bytesWritten)
            }

            start += result.bytesWritten

            if (result.bytesWritten == 0L) {
                // Nothing left to read and no total was ever reported - avoid
                // spinning forever on a misbehaving server.
                break
            }
        }
    }
}

private fun fetchChunkWithRetries(
    url: String,
    headers: Map<String, String>,
    start: Long,
    end: Long,
    raf: RandomAccessFile,
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

                val reportedTotal = parseTotalFromContentRange(response.header("Content-Range"))
                val body = response.body ?: throw IOException("Empty response body")
                val bytes = body.bytes()
                raf.seek(start)
                raf.write(bytes)
                return ChunkResult(bytes.size.toLong(), reportedTotal)
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
