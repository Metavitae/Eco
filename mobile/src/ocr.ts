import { getThumbnailAsync } from 'expo-video-thumbnails';
import TextRecognition from '@react-native-ml-kit/text-recognition';

// On-screen burned-in-caption OCR, a second parallel source alongside audio
// transcription (Drive Log 2026-08-26/09-01: "OCR On-Screen Captions as
// Second Source", elevated to required 2026-08-27). Different technology
// from whisper entirely, so it's unaffected by the repetition-loop /
// wrong-language bugs, and works even when the audio track alone doesn't -
// but it only has something to find on video with burned-in text (news/
// commentary-style captions), not a plain audio-only podcast.

const FRAME_INTERVAL_MS = 4_000;
// Caps a worst-case video at ~20 minutes of sampling. expo-video-thumbnails
// has no duration query of its own (see getThumbnailAsync's own docs) - the
// loop below stops itself early via consecutive out-of-range failures once
// the real video ends, this is just a hard backstop against a runaway loop.
const MAX_FRAMES = 300;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Burned-in captions typically persist across many consecutive frames -
// a naive frame-by-frame OCR would repeat that same line dozens of times.
// Only keep a frame's text when it isn't the same as, or a subset/superset
// of (caption text growing or shrinking slightly frame-to-frame), the last
// kept line.
function isNewCaption(normalized: string, lastNormalized: string): boolean {
  if (!normalized) return false;
  if (normalized === lastNormalized) return false;
  if (lastNormalized && (lastNormalized.includes(normalized) || normalized.includes(lastNormalized))) {
    return false;
  }
  return true;
}

// Reported explicitly rather than always returning a possibly-empty string -
// "empty" was previously indistinguishable from "broke on the very first
// frame," which is exactly the ambiguity behind the "OCR producing no
// output, can't tell if it's broken" report (Drive Log 2026-09-01).
export type OcrOutcome =
  | { status: 'found'; text: string }
  | { status: 'no-captions-found' }
  | { status: 'error'; message: string };

export async function extractOnScreenCaptions(videoUri: string): Promise<OcrOutcome> {
  const kept: string[] = [];
  let lastNormalized = '';
  let time = 0;
  let consecutiveOutOfRange = 0;
  let framesRead = 0;
  let lastError: string | undefined;

  for (let i = 0; i < MAX_FRAMES; i++) {
    let frameUri: string;
    try {
      const thumb = await getThumbnailAsync(videoUri, { time, quality: 0.5 });
      frameUri = thumb.uri;
      consecutiveOutOfRange = 0;
      framesRead += 1;
    } catch (err) {
      // Past the end of the video - two consecutive misses (not just one
      // transient decode hiccup) is the actual stop condition.
      lastError = err instanceof Error ? err.message : String(err);
      consecutiveOutOfRange += 1;
      if (consecutiveOutOfRange >= 2) break;
      time += FRAME_INTERVAL_MS;
      continue;
    }

    try {
      const { text } = await TextRecognition.recognize(frameUri);
      const normalized = normalize(text);
      if (isNewCaption(normalized, lastNormalized)) {
        kept.push(text.trim());
      }
      if (normalized) lastNormalized = normalized;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    time += FRAME_INTERVAL_MS;
  }

  if (kept.length > 0) return { status: 'found', text: kept.join('\n') };
  // Never got a single readable frame - a real failure (bad file, unreadable
  // codec, native module not linked), not "this video has no captions".
  if (framesRead === 0) {
    return { status: 'error', message: lastError ?? 'Could not read any frames from the video file.' };
  }
  return { status: 'no-captions-found' };
}
