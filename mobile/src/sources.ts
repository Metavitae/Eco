import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
// @ts-expect-error - react-native-ytdl ships no TypeScript types
import ytdl from 'react-native-ytdl';

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

function isYoutubeUrl(url: string): boolean {
  return ytdl.validateURL(url);
}

/**
 * Resolves a pasted link to a downloaded local audio file.
 * - YouTube links: resolved via react-native-ytdl, preferring an mp4/m4a
 *   (AAC) audio-only stream over webm/opus - iOS WebKit does not reliably
 *   decode Opus-in-WebM via Web Audio, so mp4/AAC keeps the WavConverter
 *   step working on both platforms.
 * - Anything else is treated as a direct audio file URL (e.g. a podcast
 *   episode's enclosure link). Podcast RSS *feed* URLs (not a direct episode
 *   link) are NOT resolved - that needs XML parsing to find the latest
 *   episode's enclosure, which is a separate feature, not attempted here.
 */
export async function resolveLinkInput(url: string): Promise<PickedInput> {
  const trimmed = url.trim();

  if (isYoutubeUrl(trimmed)) {
    const info = await ytdl.getInfo(trimmed);
    const preferred = ytdl.chooseFormat(info.formats, {
      filter: (format: any) => format.hasAudio && !format.hasVideo && format.container === 'mp4',
    });
    const format =
      preferred ?? ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
    if (!format?.url) throw new Error('Could not find a downloadable audio stream for this video.');

    const title = (info.videoDetails?.title as string) || 'youtube-audio';
    const destination = new File(Paths.cache, `eco-src-${Date.now()}.${format.container ?? 'm4a'}`);
    const task = File.createDownloadTask(format.url, Paths.cache, {});
    const downloaded = await task.downloadAsync();
    if (!downloaded) throw new Error('Failed to download audio from YouTube.');

    return {
      uri: downloaded.uri,
      mimeType: format.mimeType?.split(';')[0] ?? 'audio/mp4',
      title,
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
