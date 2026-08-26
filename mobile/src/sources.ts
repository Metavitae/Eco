import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { resolveAudioStream, downloadAudioStream } from '../modules/youtube-extractor/src';

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

// react-native-ytdl (dead since 2021) and a hand-rolled direct InnerTube
// ANDROID_VR call were both tried and both hit real YouTube defenses (PO
// Token/cipher walls, then bot-detection) within the same day - see Eco's
// Drive Log, 2026-08-20/21. Per founder directive, extraction now goes
// through NewPipeExtractor (the actively-maintained library NewPipe itself
// uses on real Android devices) via the local `youtube-extractor` Expo
// module, instead of continuing to guess at InnerTube client parameters.
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

/**
 * Resolves a pasted link to a downloaded local audio file.
 * - YouTube links: resolved via NewPipeExtractor (native module, see
 *   modules/youtube-extractor).
 * - Anything else is treated as a direct audio file URL (e.g. a podcast
 *   episode's enclosure link). Podcast RSS *feed* URLs (not a direct episode
 *   link) are NOT resolved - that needs XML parsing to find the latest
 *   episode's enclosure, which is a separate feature, not attempted here.
 */
export async function resolveLinkInput(url: string): Promise<PickedInput> {
  const trimmed = url.trim();
  const videoId = getYoutubeVideoId(trimmed);

  if (videoId) {
    const { url: streamUrl, mimeType, title, userAgent, referer } = await resolveAudioStream(videoId);
    const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '_');
    const destination = new File(Paths.cache, safeTitle);

    // Chunked native download (modules/youtube-extractor), not
    // expo-file-system's DownloadTask - its hardcoded 60s idle-read timeout
    // isn't JS-configurable and was observed failing on real 5-7min audio
    // files (while a 29s clip succeeded). Uses the same User-Agent/Referer
    // that resolved the stream, for the same reason as before.
    await downloadAudioStream(streamUrl, { 'User-Agent': userAgent, Referer: referer }, destination.uri);

    return {
      uri: destination.uri,
      mimeType,
      title: safeTitle.replace(/\.[^.]+$/, ''),
    };
  }

  // Direct audio URL (podcast episode link, etc.). Podcast episodes can run
  // well past an hour, the same duration-dependent case that broke YouTube
  // downloads on expo-file-system's DownloadTask (its hardcoded 60s
  // idle-read timeout, see downloadAudioStream's own comment) - reuse the
  // same chunked downloader here instead of hitting that wall again.
  const filenameGuess = trimmed.split('/').pop()?.split('?')[0] || `link-audio-${Date.now()}`;
  const destination = new File(Paths.cache, filenameGuess);
  await downloadAudioStream(trimmed, {}, destination.uri);

  return {
    uri: destination.uri,
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
