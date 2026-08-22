package expo.modules.youtubeextractor

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.StreamInfo

class YoutubeExtractorModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("YoutubeExtractor")

        AsyncFunction("resolveAudioStream") { videoId: String ->
            ensureInitialized()

            val info = StreamInfo.getInfo("https://www.youtube.com/watch?v=$videoId")
            val audioStreams: List<AudioStream> = info.audioStreams
            if (audioStreams.isEmpty()) {
                throw IllegalStateException("Could not find a downloadable audio stream for this video.")
            }

            // Prefer M4A/AAC over WebM/Opus - matches the existing preference
            // in sources.ts's WebView WAV-converter step, which needs a
            // format iOS/Android WebViews both reliably decode.
            val preferred = audioStreams.firstOrNull {
                it.format?.name?.contains("M4A", ignoreCase = true) == true
            } ?: audioStreams.maxByOrNull { it.averageBitrate }
                ?: audioStreams[0]

            val extension = if (
                preferred.format?.name?.contains("M4A", ignoreCase = true) == true
            ) "m4a" else "webm"

            mapOf(
                "url" to preferred.content,
                "mimeType" to (if (extension == "m4a") "audio/mp4" else "audio/webm"),
                "title" to "${info.name}.$extension",
            )
        }
    }

    @Synchronized
    private fun ensureInitialized() {
        if (!initialized) {
            NewPipe.init(OkHttpDownloader())
            initialized = true
        }
    }

    companion object {
        @Volatile
        private var initialized = false
    }
}
