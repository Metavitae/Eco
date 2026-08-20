import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { File, Paths } from 'expo-file-system';
import { buildWavConverterHtml } from './wavConverterHtml';

export type WavConverterHandle = {
  /** Converts any audio the platform's WebView can decode into a 16kHz mono
   * WAV file and returns its local file:// uri. Throws on unsupported/corrupt
   * input (e.g. Opus/WebM on iOS is not reliably decodable). */
  convertToWav: (sourceUri: string, mimeType: string) => Promise<string>;
};

type PendingJob = {
  resolve: (uri: string) => void;
  reject: (err: Error) => void;
};

export const WavConverter = forwardRef<WavConverterHandle>((_props, ref) => {
  const [html, setHtml] = useState<string | null>(null);
  const pendingRef = useRef<PendingJob | null>(null);

  useImperativeHandle(ref, () => ({
    convertToWav: (sourceUri: string, mimeType: string) => {
      return new Promise<string>(async (resolve, reject) => {
        try {
          const sourceFile = new File(sourceUri);
          const base64Audio = await sourceFile.base64();
          pendingRef.current = { resolve, reject };
          setHtml(buildWavConverterHtml(base64Audio, mimeType));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
  }));

  const handleMessage = (event: WebViewMessageEvent) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setHtml(null);
    if (!pending) return;

    try {
      const data = JSON.parse(event.nativeEvent.data) as
        | { ok: true; base64Wav: string }
        | { ok: false; error: string };

      if (!data.ok) {
        pending.reject(new Error(data.error));
        return;
      }

      const outFile = new File(Paths.cache, `eco-${Date.now()}.wav`);
      outFile.write(data.base64Wav, { encoding: 'base64' });
      pending.resolve(outFile.uri);
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };

  if (!html) return null;

  return (
    <WebView
      source={{ html }}
      onMessage={handleMessage}
      onError={(e) => {
        const pending = pendingRef.current;
        pendingRef.current = null;
        setHtml(null);
        pending?.reject(new Error(`WebView error: ${e.nativeEvent.description}`));
      }}
      style={styles.hidden}
      javaScriptEnabled
      domStorageEnabled
      originWhitelist={['*']}
    />
  );
});

const styles = StyleSheet.create({
  // WebView must be mounted (not display:none) for its JS to run reliably
  // on both platforms, so it's sized to ~0 instead of hidden.
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});
