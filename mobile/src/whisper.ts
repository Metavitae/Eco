import { initWhisper, WhisperContext } from 'whisper.rn';
import { File, Paths } from 'expo-file-system';

// Base multilingual model (EN+ES, matches the Chromebook prototype's
// confirmed default - see Drive Log 2026-08-19: tiny had a real Spanish
// accuracy bug base fixed). ~142MB, downloaded once and cached on-device
// rather than bundled, per whisper.rn's own guidance (too large to bundle
// comfortably / hits Metro's asset pipeline limits).
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const MODEL_FILENAME = 'ggml-base.bin';

let contextPromise: Promise<WhisperContext> | null = null;

export type ModelDownloadProgress = { bytesWritten: number; totalBytes: number };

// If the response has no Content-Length (confirmed on WiFi, see Drive Log
// 2026-08-26: "Model loading slow, no progress feedback" - Android's native
// downloader reports totalBytes as -1 in that case), a naive `fraction`
// callback never fires even though the download is genuinely progressing.
// Report raw byte counts instead so the UI can always show real feedback.
const STALL_TIMEOUT_MS = 30_000;

export async function ensureModelDownloaded(
  onProgress?: (progress: ModelDownloadProgress) => void
): Promise<string> {
  const modelFile = new File(Paths.document, MODEL_FILENAME);
  if (modelFile.exists && modelFile.size && modelFile.size > 50_000_000) {
    return modelFile.uri;
  }

  let lastBytesWritten = 0;
  let lastProgressAt = Date.now();

  const task = File.createDownloadTask(MODEL_URL, Paths.document, {
    onProgress: (progress) => {
      if (progress.bytesWritten > lastBytesWritten) {
        lastBytesWritten = progress.bytesWritten;
        lastProgressAt = Date.now();
      }
      onProgress?.(progress);
    },
  });

  const stallCheck = setInterval(() => {
    if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
      task.cancel();
    }
  }, 5_000);

  try {
    const downloaded = await task.downloadAsync();
    if (!downloaded) throw new Error('Model download failed.');
    return downloaded.uri;
  } catch (err) {
    if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
      throw new Error(
        `Model download stalled (no progress for ${STALL_TIMEOUT_MS / 1000}s) and was cancelled. Check your connection and try again.`
      );
    }
    throw err;
  } finally {
    clearInterval(stallCheck);
  }
}

export async function getWhisperContext(
  onModelProgress?: (progress: ModelDownloadProgress) => void
): Promise<WhisperContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const modelPath = await ensureModelDownloaded(onModelProgress);
      return initWhisper({ filePath: modelPath });
    })();
  }
  return contextPromise;
}

export type TranscribeResult = {
  text: string;
  language: string;
};

// whisper.cpp's entropy/logprob quality checks are meant to catch a bad
// decode and trigger the temperature fallback, but a repetition loop is
// often decoded with high confidence (low entropy, good logprob) and slips
// past both those checks and beam search (see Drive Log 2026-08-26, second
// confirmed instance after beamSize alone didn't fix it). Detect the
// resulting pattern directly: a short run of words repeated enough times to
// dominate the transcript.
function hasRepetitionLoop(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 30) return false;

  for (let windowSize = 4; windowSize <= 12; windowSize++) {
    const counts = new Map<string, number>();
    for (let i = 0; i + windowSize <= words.length; i++) {
      const gram = words.slice(i, i + windowSize).join(' ').toLowerCase();
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      if (count >= 5 && (count * windowSize) / words.length > 0.5) {
        return true;
      }
    }
  }
  return false;
}

async function runTranscription(
  context: WhisperContext,
  wavUri: string,
  language: string | null,
  temperature?: number,
  onProgress?: (progress: number) => void
): Promise<TranscribeResult> {
  const { promise } = context.transcribe(wavUri, {
    language: language ?? 'auto',
    // Explicit belt-and-suspenders: whisper.cpp's forced-language decoding
    // (e.g. auto-detect misfiring on a music/silent intro) can otherwise
    // produce an English translation instead of a same-language transcript.
    translate: false,
    // Beam search explores multiple continuations per step, which helps
    // against the greedy strategy's repetition-loop tendency, though not
    // reliably on its own (see hasRepetitionLoop above).
    beamSize: 5,
    // whisper.cpp's own internal temperature-fallback cascade (temperature
    // -> += temperatureInc, up to 1.0) is driven by its entropy/logprob/
    // compression-ratio quality checks - exactly the checks a confidently-
    // looped decode slips past (see hasRepetitionLoop's comment). Setting it
    // here is still worth doing (it catches segments that DO trip those
    // checks), but it's not what fixes the confident-loop case - that needs
    // our own outer retry across explicit temperatures below.
    temperatureInc: 0.2,
    ...(temperature !== undefined ? { temperature } : {}),
    onProgress,
  });
  const { result, language: detectedLanguage } = await promise;
  return { text: result.trim(), language: detectedLanguage };
}

export async function transcribeWav(
  wavUri: string,
  language: string | null,
  onModelProgress?: (progress: ModelDownloadProgress) => void,
  onTranscribeProgress?: (progress: number) => void
): Promise<TranscribeResult> {
  const context = await getWhisperContext(onModelProgress);

  const first = await runTranscription(context, wavUri, language, undefined, onTranscribeProgress);
  if (!hasRepetitionLoop(first.text)) return first;

  // A single fixed-temperature retry (previously just 0.8) still failed a
  // third confirmed time (Drive Log 2026-09-01) - a genuinely stuck decode
  // needs more than one shot at breaking its deterministic path. Cascade
  // through several explicit temperatures, same mitigation, more attempts.
  for (const temperature of [0.2, 0.4, 0.6, 0.8, 1.0]) {
    const retry = await runTranscription(context, wavUri, language, temperature, onTranscribeProgress);
    if (!hasRepetitionLoop(retry.text)) return retry;
  }

  throw new Error(
    'Transcription got stuck repeating the same phrase, even after retrying at multiple decoding temperatures. This is a known whisper.cpp failure mode on some audio - try a different source, or try this one again.'
  );
}
