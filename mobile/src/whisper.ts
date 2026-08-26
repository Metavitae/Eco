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

export async function ensureModelDownloaded(
  onProgress?: (fraction: number) => void
): Promise<string> {
  const modelFile = new File(Paths.document, MODEL_FILENAME);
  if (modelFile.exists && modelFile.size && modelFile.size > 50_000_000) {
    return modelFile.uri;
  }

  const task = File.createDownloadTask(MODEL_URL, Paths.document, {
    onProgress: ({ bytesWritten, totalBytes }) => {
      if (totalBytes > 0) onProgress?.(bytesWritten / totalBytes);
    },
  });
  const downloaded = await task.downloadAsync();
  if (!downloaded) throw new Error('Model download failed.');
  return downloaded.uri;
}

export async function getWhisperContext(
  onModelProgress?: (fraction: number) => void
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
  temperature?: number
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
    ...(temperature !== undefined ? { temperature } : {}),
  });
  const { result, language: detectedLanguage } = await promise;
  return { text: result.trim(), language: detectedLanguage };
}

export async function transcribeWav(
  wavUri: string,
  language: string | null,
  onModelProgress?: (fraction: number) => void
): Promise<TranscribeResult> {
  const context = await getWhisperContext(onModelProgress);

  const first = await runTranscription(context, wavUri, language);
  if (!hasRepetitionLoop(first.text)) return first;

  // Forcing a higher starting temperature (instead of the default 0.0)
  // is the standard mitigation for a confidently-looping decode: it
  // breaks the deterministic path that produced the loop.
  const retry = await runTranscription(context, wavUri, language, 0.8);
  if (!hasRepetitionLoop(retry.text)) return retry;

  throw new Error(
    'Transcription got stuck repeating the same phrase, even after retrying. This is a known whisper.cpp failure mode on some audio - try a different source, or try this one again.'
  );
}
