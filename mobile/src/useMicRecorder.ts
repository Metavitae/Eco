import { useState } from 'react';
import {
  useAudioRecorder,
  RecordingPresets,
  AudioModule,
  setAudioModeAsync,
} from 'expo-audio';
import type { PickedInput } from './sources';

export function useMicRecorder() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording] = useState(false);

  const start = async () => {
    const status = await AudioModule.requestRecordingPermissionsAsync();
    if (!status.granted) throw new Error('Microphone permission denied.');

    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    setIsRecording(true);
  };

  const stop = async (): Promise<PickedInput> => {
    await recorder.stop();
    setIsRecording(false);
    if (!recorder.uri) throw new Error('Recording did not produce a file.');
    return {
      uri: recorder.uri,
      mimeType: 'audio/mp4', // HIGH_QUALITY preset -> .m4a (AAC)
      title: `Recording ${new Date().toLocaleString()}`,
    };
  };

  return { isRecording, start, stop };
}
