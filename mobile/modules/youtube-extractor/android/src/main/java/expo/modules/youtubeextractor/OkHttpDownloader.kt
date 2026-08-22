package expo.modules.youtubeextractor

import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request as OkRequest
import okhttp3.RequestBody.Companion.toRequestBody
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import java.util.concurrent.TimeUnit

// Mirrors NewPipe's own DownloaderImpl - NewPipeExtractor needs a real
// User-Agent and header passthrough or YouTube's InnerTube endpoints refuse
// the request outright, same failure mode this module exists to get past.
private const val USER_AGENT =
    "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/120.0.0.0 Mobile Safari/537.36"

class OkHttpDownloader : Downloader() {
    private val client = OkHttpClient.Builder()
        .readTimeout(30, TimeUnit.SECONDS)
        .connectTimeout(30, TimeUnit.SECONDS)
        .build()

    override fun execute(request: Request): Response {
        val httpMethod = request.httpMethod()
        val url = request.url()
        val headers = request.headers()
        val dataToSend = request.dataToSend()

        val requestBody = if (dataToSend != null) {
            val contentType = headers["Content-Type"]?.firstOrNull()
            dataToSend.toRequestBody(contentType?.toMediaTypeOrNull())
        } else {
            null
        }

        val builder = OkRequest.Builder()
            .method(httpMethod, requestBody)
            .url(url)
            .header("User-Agent", USER_AGENT)

        for ((key, values) in headers) {
            if (key.equals("User-Agent", ignoreCase = true)) continue
            builder.removeHeader(key)
            for (value in values) {
                builder.addHeader(key, value)
            }
        }

        client.newCall(builder.build()).execute().use { response ->
            val body = response.body?.string() ?: ""
            return Response(
                response.code,
                response.message,
                response.headers.toMultimap(),
                body,
                response.request.url.toString(),
            )
        }
    }
}
