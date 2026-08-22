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
};

const YoutubeExtractor = requireNativeModule<YoutubeExtractorModuleType>('YoutubeExtractor');

export function resolveAudioStream(videoId: string): Promise<ResolvedAudioStream> {
  return YoutubeExtractor.resolveAudioStream(videoId);
}
