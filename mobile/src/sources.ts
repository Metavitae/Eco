import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { resolveAudioStream } from '../modules/youtube-extractor/src';

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
    // The resolved stream url is only reliable when fetched with the same
    // User-Agent (and a Referer) that resolved it - a bare request with no
    // headers has been observed to hang until YouTube's CDN times it out.
    const task = File.createDownloadTask(streamUrl, Paths.cache, {
      headers: { 'User-Agent': userAgent, Referer: referer },
    });
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
