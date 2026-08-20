#!/usr/bin/env python3
"""Eco CLI: paste a YouTube/podcast link, get a full plain-text transcript.

For the paste-a-link web interface, run webapp/app.py instead.
"""
import argparse

from eco_core import DEFAULT_MODEL, Transcriber, run_pipeline


def main():
    parser = argparse.ArgumentParser(description="Eco: link -> full plain-text transcript")
    parser.add_argument("url", help="YouTube or podcast audio URL")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"faster-whisper model size (default: {DEFAULT_MODEL})")
    parser.add_argument("--language", default=None, help="Force language code (e.g. en, es). Default: auto-detect")
    parser.add_argument("--keep-audio", action="store_true", help="Keep the extracted audio file instead of deleting it")
    args = parser.parse_args()

    transcriber = Transcriber(args.model)
    result = run_pipeline(args.url, transcriber, language=args.language,
                           keep_audio=args.keep_audio, on_step=print)

    print(f"\nDone: Transcripts/{result['filename']}")
    print(f"Detected language: {result['detected_language']} (p={result['language_probability']:.2f})")
    print(f"Audio duration: {result['duration_sec']:.1f}s | Transcribe time: {result['elapsed_sec']:.1f}s")


if __name__ == "__main__":
    main()
