import React, { useRef, useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
  Alert,
} from 'react-native';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';

import { WavConverter, WavConverterHandle } from './src/WavConverter';
import { pickLocalFile, resolveLinkInput, PickedInput } from './src/sources';
import { useMicRecorder } from './src/useMicRecorder';
import { transcribeWav } from './src/whisper';

// Speaker diarization ("who said what") is intentionally NOT implemented
// yet - no ready React Native library exists for it as of this build
// (confirmed via research 2026-08-19). It would plug in here: after
// transcribeWav() resolves and before the transcript is displayed, run the
// same wavUri through a diarization pass and merge speaker turns into the
// text. Needs a custom native bridge to sherpa-onnx - its own build phase.

type Status = 'idle' | 'working' | 'done' | 'error';

export default function App() {
  const converterRef = useRef<WavConverterHandle>(null);
  const mic = useMicRecorder();

  const [status, setStatus] = useState<Status>('idle');
  const [step, setStep] = useState('');
  const [transcript, setTranscript] = useState('');
  const [transcriptTitle, setTranscriptTitle] = useState('');
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');

  const runPipeline = async (input: PickedInput) => {
    setStatus('working');
    setError('');
    setTranscript('');
    try {
      let wavUri = input.uri;
      if (input.mimeType !== 'audio/wav') {
        setStep('Converting audio...');
        if (!converterRef.current) throw new Error('Converter not ready.');
        wavUri = await converterRef.current.convertToWav(input.uri, input.mimeType);
      }

      setStep('Loading model (first run downloads ~142MB)...');
      const result = await transcribeWav(wavUri, null, (fraction) => {
        setStep(`Downloading model... ${Math.round(fraction * 100)}%`);
      });

      setTranscriptTitle(input.title);
      setTranscript(result.text);
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  const handlePickFile = async () => {
    try {
      const picked = await pickLocalFile();
      if (picked) await runPipeline(picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  const handleMicPress = async () => {
    try {
      if (!mic.isRecording) {
        await mic.start();
      } else {
        const picked = await mic.stop();
        await runPipeline(picked);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  const handleLinkSubmit = async () => {
    if (!url.trim()) return;
    setStatus('working');
    setStep('Fetching link...');
    setError('');
    try {
      const picked = await resolveLinkInput(url.trim());
      await runPipeline(picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  const handleShare = async () => {
    const file = new File(Paths.cache, `${transcriptTitle || 'transcript'}.txt`);
    file.write(transcript);
    if (await Sharing.isAvailableAsync()) {
      // expo-sharing defaults to mimeType "*/*" when none is passed (it does
      // not infer from the file extension) - explicit text/plain is what
      // makes Drive/Docs rank as real targets in the share sheet.
      await Sharing.shareAsync(file.uri, { mimeType: 'text/plain' });
    } else {
      Alert.alert('Sharing not available on this device.');
    }
  };

  const busy = status === 'working';

  return (
    <SafeAreaView style={styles.container}>
      <WavConverter ref={converterRef} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>Eco</Text>
        <Text style={styles.subtitle}>
          Transcribe a file, a recording, or a link. Fully on-device, nothing sent anywhere paid.
        </Text>

        <TouchableOpacity style={styles.button} onPress={handlePickFile} disabled={busy}>
          <Text style={styles.buttonText}>Pick audio or video file</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, mic.isRecording && styles.buttonRecording]}
          onPress={handleMicPress}
          disabled={busy && !mic.isRecording}
        >
          <Text style={styles.buttonText}>{mic.isRecording ? 'Stop recording' : 'Record from mic'}</Text>
        </TouchableOpacity>

        <View style={styles.linkRow}>
          <TextInput
            style={styles.input}
            placeholder="Paste a YouTube or podcast link"
            value={url}
            onChangeText={setUrl}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.linkButton} onPress={handleLinkSubmit} disabled={busy}>
            <Text style={styles.buttonText}>Go</Text>
          </TouchableOpacity>
        </View>

        {busy && (
          <View style={styles.statusRow}>
            <ActivityIndicator />
            <Text style={styles.statusText}>{step}</Text>
          </View>
        )}

        {status === 'error' && <Text style={styles.error}>{error}</Text>}

        {status === 'done' && (
          <View style={styles.result}>
            <Text style={styles.resultTitle}>{transcriptTitle}</Text>
            <Text style={styles.transcript}>{transcript}</Text>
            <TouchableOpacity style={styles.button} onPress={handleShare}>
              <Text style={styles.buttonText}>Share transcript</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 20, gap: 12 },
  h1: { fontSize: 28, fontWeight: '700' },
  subtitle: { color: '#666', marginBottom: 12 },
  button: {
    backgroundColor: '#2d6a4f',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonRecording: { backgroundColor: '#b3261e' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  linkRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  linkButton: {
    backgroundColor: '#2d6a4f',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  statusText: { color: '#555' },
  error: { color: '#b3261e', marginTop: 8 },
  result: { marginTop: 16, gap: 12 },
  resultTitle: { fontSize: 16, fontWeight: '600' },
  transcript: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    padding: 12,
    maxHeight: 400,
  },
});
