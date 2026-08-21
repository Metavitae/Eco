import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';

export type PickedInput = {
  uri: string;
  mimeType: string;
  title: string;
};

export async function pickLocalFile(): Promise<PickedInput | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['audio/*', 'video/*'],
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    mimeType: asset.mimeType ?? 'audio/mpeg',
    title: asset.name.replace(/\.[^.]+$/, ''),
  };
}

// react-native-ytdl (last published 2021) is dead: YouTube's WEB/ANDROID/IOS
// InnerTube clients now all require a GVS PO Token to return a stream url or
// signatureCipher at all (the "SABR-only streaming" rollout - see
// https://github.com/yt-dlp/yt-dlp/issues/12482, hit the same wall in eco_core.py's
// yt-dlp pipeline). ANDROID_VR is, as of 2026-08-20, the one InnerTube client that
// still returns a plain, undeciphered `url` with no PO Token needed (confirmed
// against yt-dlp's own extractor, which marks it REQUIRE_JS_PLAYER: False). So we
// call InnerTube directly as that client instead of going through any ytdl library -
// there's no cipher step to reimplement.
const VALID_YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'gaming.youtube.com',
]);
const YT_PATH_HOST_REGEXP = /^https?:\/\/(youtu\.be\/|(www\.)?youtube\.com\/(embed|v|shorts)\/)/;
const YT_ID_REGEXP = /^[a-zA-Z0-9-_]{11}$/;

function getYoutubeVideoId(link: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return null;
  }
  let id = parsed.searchParams.get('v');
  if (YT_PATH_HOST_REGEXP.test(link) && !id) {
    const paths = parsed.pathname.split('/');
    id = paths[paths.length - 1];
  } else if (parsed.hostname && !VALID_YT_HOSTS.has(parsed.hostname)) {
    return null;
  }
  if (!id) return null;
  id = id.substring(0, 11);
  return YT_ID_REGEXP.test(id) ? id : null;
}

const ANDROID_VR_CLIENT_VERSION = '1.65.10';
const ANDROID_VR_USER_AGENT = `com.google.android.apps.youtube.vr.oculus/${ANDROID_VR_CLIENT_VERSION} (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip`;

type InnertubeFormat = {
  mimeType?: string;
  url?: string;
  bitrate?: number;
};

async function resolveYoutubeAudio(
  videoId: string,
): Promise<{ url: string; mimeType: string; title: string }> {
  const response = await fetch('https://youtubei.googleapis.com/youtubei/v1/player', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': ANDROID_VR_USER_AGENT,
      'X-Goog-Api-Format-Version': '2',
    },
    body: JSON.stringify({
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      context: {
        client: {
          clientName: 'ANDROID_VR',
          clientVersion: ANDROID_VR_CLIENT_VERSION,
          deviceMake: 'Oculus',
          deviceModel: 'Quest 3',
          androidSdkVersion: 32,
          osName: 'Android',
          osVersion: '12L',
          hl: 'en',
          gl: 'US',
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`YouTube lookup failed (HTTP ${response.status}).`);
  }
  const data = await response.json();
  if (data?.playabilityStatus?.status !== 'OK') {
    throw new Error(data?.playabilityStatus?.reason || 'This video is not playable.');
  }

  const formats: InnertubeFormat[] = data?.streamingData?.adaptiveFormats ?? [];
  const audioFormats = formats.filter((f) => f.mimeType?.startsWith('audio/') && f.url);
  if (!audioFormats.length) {
    throw new Error('Could not find a downloadable audio stream for this video.');
  }
  // Prefer mp4/AAC over webm/opus - iOS WebKit does not reliably decode
  // Opus-in-WebM via Web Audio, so mp4/AAC keeps the WavConverter step
  // working on both platforms.
  const preferred =
    audioFormats.find((f) => f.mimeType?.includes('mp4')) ??
    audioFormats.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];

  const title = data?.videoDetails?.title || 'youtube-audio';
  const container = preferred.mimeType?.includes('mp4') ? 'm4a' : 'webm';
  const mimeType = preferred.mimeType?.split(';')[0] ?? 'audio/mp4';
  return { url: preferred.url as string, mimeType, title: `${title}.${container}` };
}

/**
 * Resolves a pasted link to a downloaded local audio file.
 * - YouTube links: resolved via a direct InnerTube ANDROID_VR call (see
 *   resolveYoutubeAudio above for why).
 * - Anything else is treated as a direct audio file URL (e.g. a podcast
 *   episode's enclosure link). Podcast RSS *feed* URLs (not a direct episode
 *   link) are NOT resolved - that needs XML parsing to find the latest
 *   episode's enclosure, which is a separate feature, not attempted here.
 */
export async function resolveLinkInput(url: string): Promise<PickedInput> {
  const trimmed = url.trim();
  const videoId = getYoutubeVideoId(trimmed);

  if (videoId) {
    const { url: streamUrl, mimeType, title } = await resolveYoutubeAudio(videoId);
    const task = File.createDownloadTask(streamUrl, Paths.cache, {});
    const downloaded = await task.downloadAsync();
    if (!downloaded) throw new Error('Failed to download audio from YouTube.');

    return {
      uri: downloaded.uri,
      mimeType,
      title: title.replace(/\.[^.]+$/, ''),
    };
  }

  // Direct audio URL (podcast episode link, etc.)
  const filenameGuess = trimmed.split('/').pop()?.split('?')[0] || `link-audio-${Date.now()}`;
  const task = File.createDownloadTask(trimmed, Paths.cache, {});
  const downloaded = await task.downloadAsync();
  if (!downloaded) throw new Error('Failed to download audio from this link.');

  return {
    uri: downloaded.uri,
    mimeType: guessMimeType(filenameGuess),
    title: filenameGuess.replace(/\.[^.]+$/, ''),
  };
}

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
    case 'opus':
      return 'audio/ogg';
    default:
      return 'audio/mpeg';
  }
}
