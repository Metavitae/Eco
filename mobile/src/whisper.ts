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

export async function transcribeWav(
  wavUri: string,
  language: string | null,
  onModelProgress?: (fraction: number) => void
): Promise<TranscribeResult> {
  const context = await getWhisperContext(onModelProgress);
  const { promise } = context.transcribe(wavUri, {
    language: language ?? 'auto',
    // Explicit belt-and-suspenders: whisper.cpp's forced-language decoding
    // (e.g. auto-detect misfiring on a music/silent intro) can otherwise
    // produce an English translation instead of a same-language transcript.
    translate: false,
    // whisper.cpp's default WHISPER_SAMPLING_GREEDY strategy is prone to
    // getting stuck re-emitting the same phrase on real-world audio (see
    // Drive Log 2026-08-25, repetition-loop bug). Its built-in temperature
    // fallback (entropy/logprob threshold retry) is on by default but often
    // isn't enough on its own; beam search explores multiple continuations
    // per step and is the standard, well-documented fix for this failure
    // mode, matching whisper.cpp's own examples and upstream OpenAI Whisper.
    beamSize: 5,
  });
  const { result, language: detectedLanguage } = await promise;
  return { text: result.trim(), language: detectedLanguage };
}
