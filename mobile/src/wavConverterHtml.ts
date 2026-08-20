// Runs inside a hidden WebView. Uses the platform's built-in Web Audio
// decoder (whatever the device's browser engine can decode - mp3, m4a/aac,
// wav all work; opus/webm is NOT reliably supported on iOS Safari, so
// callers should prefer mp4/m4a audio streams where there's a choice) to
// turn arbitrary compressed audio into 16-bit PCM mono WAV at 16kHz, which
// is the only format whisper.rn accepts directly.
export function buildWavConverterHtml(base64Audio: string, mimeType: string): string {
  return `<!doctype html>
<html><body>
<script>
function post(msg) {
  window.ReactNativeWebView.postMessage(JSON.stringify(msg));
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, s, true);
  }
  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function encodeWav(pcmBuffer, sampleRate, numChannels, bitDepth) {
  const blockAlign = (numChannels * bitDepth) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBuffer.byteLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, pcmBuffer.byteLength, true);
  const out = new Uint8Array(44 + pcmBuffer.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(new Uint8Array(pcmBuffer), 44);
  return out.buffer;
}

async function run() {
  try {
    const TARGET_RATE = 16000;
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = base64ToArrayBuffer("${base64Audio}");
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);

    const offline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      1,
      Math.ceil(decoded.duration * TARGET_RATE),
      TARGET_RATE
    );
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    const channelData = rendered.getChannelData(0);

    const pcm = floatTo16BitPCM(channelData);
    const wav = encodeWav(pcm, TARGET_RATE, 1, 16);
    const base64Wav = arrayBufferToBase64(wav);
    post({ ok: true, base64Wav });
  } catch (err) {
    post({ ok: false, error: String((err && err.message) || err) });
  }
}
run();
</script>
</body></html>`;
}
