package expo.modules.youtubeextractor

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.VideoStream

class YoutubeExtractorModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("YoutubeExtractor")

        AsyncFunction("resolveAudioStream") { videoId: String ->
            ensureInitialized()

            val info = StreamInfo.getInfo("https://www.youtube.com/watch?v=$videoId")
            val source = pickAudioSource(info.audioStreams, info.videoStreams)

            mapOf(
                "url" to source.url,
                "mimeType" to source.mimeType,
                "title" to "${info.name}.${source.extension}",
                // YouTube's CDN can silently stall/timeout a plain request to a
                // resolved stream url - the download step needs to send the same
                // User-Agent (and a Referer) that resolved it.
                "userAgent" to USER_AGENT,
                "referer" to "https://www.youtube.com/",
            )
        }
    }

    private data class AudioSource(val url: String, val mimeType: String, val extension: String)

    private fun pickAudioSource(
        audioStreams: List<AudioStream>,
        muxedVideoStreams: List<VideoStream>,
    ): AudioSource {
        if (audioStreams.isNotEmpty()) {
            // Prefer M4A/AAC over WebM/Opus - matches the existing preference
            // in sources.ts's WebView WAV-converter step, which needs a
            // format iOS/Android WebViews both reliably decode.
            val preferred = audioStreams.firstOrNull {
                it.format?.name?.contains("M4A", ignoreCase = true) == true
            } ?: audioStreams.maxByOrNull { it.averageBitrate } ?: audioStreams[0]
            val url = preferred.content
                ?: throw IllegalStateException("Found an audio stream with no downloadable url.")
            val isM4a = preferred.format?.name?.contains("M4A", ignoreCase = true) == true
            return if (isM4a) {
                AudioSource(url, "audio/mp4", "m4a")
            } else {
                AudioSource(url, "audio/webm", "webm")
            }
        }

        // Some videos expose no audio-only adaptive stream at all - fall back
        // to the smallest muxed video+audio stream rather than failing
        // outright. Only the audio track is needed, so pick the lowest
        // resolution to keep the download small.
        if (muxedVideoStreams.isNotEmpty()) {
            val smallest = muxedVideoStreams.minByOrNull { it.height } ?: muxedVideoStreams[0]
            val url = smallest.content
                ?: throw IllegalStateException("Found a video stream with no downloadable url.")
            return AudioSource(url, "video/mp4", "mp4")
        }

        throw IllegalStateException("Could not find a downloadable audio stream for this video.")
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
