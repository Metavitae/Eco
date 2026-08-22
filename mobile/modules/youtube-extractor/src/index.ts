import { requireNativeModule } from 'expo-modules-core';

export type ResolvedAudioStream = {
  url: string;
  mimeType: string;
  title: string;
  userAgent: string;
  referer: string;
};

type YoutubeExtractorModuleType = {
  resolveAudioStream(videoId: string): Promise<ResolvedAudioStream>;
  downloadAudioStream(
    url: string,
    headers: Record<string, string>,
    destinationPath: string,
  ): Promise<void>;
};

const YoutubeExtractor = requireNativeModule<YoutubeExtractorModuleType>('YoutubeExtractor');

export function resolveAudioStream(videoId: string): Promise<ResolvedAudioStream> {
  return YoutubeExtractor.resolveAudioStream(videoId);
}

// Chunked Range-based download with no overall time ceiling - see
// ChunkedDownloader.kt for why this replaces expo-file-system's DownloadTask
// for YouTube audio specifically (its hardcoded 60s idle-read timeout isn't
// configurable from JS and was observed failing on real 5-7min audio files).
export function downloadAudioStream(
  url: string,
  headers: Record<string, string>,
  destinationPath: string,
): Promise<void> {
  return YoutubeExtractor.downloadAudioStream(url, headers, destinationPath);
}
