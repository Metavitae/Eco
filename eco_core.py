"""Shared Eco pipeline: link -> audio -> transcript.

Pipeline (per Eco - Correction 2 to Direct Instructions, 2026-08-19):
  1. yt-dlp extracts audio only - no captions/subtitles ever pulled.
  2. faster-whisper transcribes the audio locally (free, offline).
  3. One unabridged .txt transcript per source, saved to Transcripts/.

No paid AI service, no API key, no account, ever, at runtime.
"""
import subprocess
import sys
import time
from pathlib import Path

from faster_whisper import WhisperModel

ECO_ROOT = Path(__file__).resolve().parent
TRANSCRIPTS_DIR = ECO_ROOT / "Transcripts"
AUDIO_TMP_DIR = ECO_ROOT / ".audio_tmp"

# Base confirmed as the safe default: fixed a real Spanish accuracy bug
# ("ballena" -> "vagina") that tiny had, still ran with 900MB+ RAM headroom
# on this machine's 2.7GB ceiling. See Drive Log, 2026-08-19.
DEFAULT_MODEL = "base"


def extract_audio(url: str, out_dir: Path = AUDIO_TMP_DIR) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    out_template = str(out_dir / "%(title)s.%(ext)s")
    cmd = [
        "yt-dlp",
        "-x", "--audio-format", "mp3",
        "--no-playlist",
        # "android" client avoids the GVS PO-token / SABR-streaming wall that
        # blocks web/ios/mweb/tv clients from this network as of 2026-08.
        "--extractor-args", "youtube:player_client=android",
        "-o", out_template,
        "--print", "after_move:filepath",
        url,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "yt-dlp failed")
    filepath = result.stdout.strip().splitlines()[-1]
    return Path(filepath)


class Transcriber:
    """Loads the whisper model once and reuses it across jobs."""

    def __init__(self, model_size: str = DEFAULT_MODEL):
        self.model_size = model_size
        self.model = WhisperModel(model_size, device="cpu", compute_type="int8")

    def transcribe(self, audio_path: Path, language: str | None = None) -> tuple[str, dict]:
        t0 = time.time()
        segments, info = self.model.transcribe(str(audio_path), language=language, beam_size=1)
        text_parts = [seg.text.strip() for seg in segments]
        elapsed = time.time() - t0
        stats = {
            "detected_language": info.language,
            "language_probability": info.language_probability,
            "duration_sec": info.duration,
            "elapsed_sec": elapsed,
        }
        return " ".join(text_parts).strip(), stats


def run_pipeline(url: str, transcriber: Transcriber, language: str | None = None,
                  keep_audio: bool = False, on_step=lambda msg: None) -> dict:
    """Full link -> .txt pipeline. Returns a result dict; raises on failure."""
    on_step("Extracting audio...")
    audio_path = extract_audio(url)

    on_step(f"Transcribing ({transcriber.model_size} model)...")
    text, stats = transcriber.transcribe(audio_path, language=language)

    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = TRANSCRIPTS_DIR / (audio_path.stem + ".txt")
    out_path.write_text(text, encoding="utf-8")

    if not keep_audio:
        audio_path.unlink(missing_ok=True)

    return {
        "title": audio_path.stem,
        "text": text,
        "filename": out_path.name,
        **stats,
    }
