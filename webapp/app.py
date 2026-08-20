#!/usr/bin/env python3
"""Eco web interface: paste a link, get a transcript.

Runs entirely on localhost. No account, no API key, no paid service ever.
Jobs run one at a time (single background worker) to stay inside this
machine's tight RAM ceiling - see Drive Log, 2026-08-19 RAM test.
"""
import sys
import threading
import queue
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flask import Flask, request, jsonify, render_template, send_from_directory, abort

from eco_core import DEFAULT_MODEL, TRANSCRIPTS_DIR, Transcriber, run_pipeline

app = Flask(__name__)

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
job_queue: "queue.Queue[str]" = queue.Queue()

_transcriber: Transcriber | None = None


def get_transcriber() -> Transcriber:
    global _transcriber
    if _transcriber is None:
        _transcriber = Transcriber(DEFAULT_MODEL)
    return _transcriber


def worker_loop():
    while True:
        job_id = job_queue.get()
        with jobs_lock:
            job = jobs[job_id]
            job["status"] = "running"
            job["step"] = "Starting..."

        def on_step(msg):
            with jobs_lock:
                jobs[job_id]["step"] = msg

        try:
            transcriber = get_transcriber()
            result = run_pipeline(job["url"], transcriber, language=job["language"], on_step=on_step)
            with jobs_lock:
                job["status"] = "done"
                job["result"] = result
        except Exception as e:
            with jobs_lock:
                job["status"] = "error"
                job["error"] = str(e)


threading.Thread(target=worker_loop, daemon=True).start()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/submit", methods=["POST"])
def submit():
    data = request.get_json(force=True)
    url = (data.get("url") or "").strip()
    language = data.get("language") or None
    if not url:
        return jsonify({"error": "Paste a link first."}), 400

    job_id = uuid.uuid4().hex
    with jobs_lock:
        position = job_queue.qsize()
        jobs[job_id] = {
            "url": url,
            "language": language,
            "status": "queued",
            "step": f"Queued ({position} ahead)" if position else "Queued",
        }
    job_queue.put(job_id)
    return jsonify({"job_id": job_id})


@app.route("/status/<job_id>")
def status(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            abort(404)
        return jsonify({
            "status": job["status"],
            "step": job.get("step", ""),
            "error": job.get("error"),
            "result": job.get("result"),
        })


@app.route("/download/<path:filename>")
def download(filename):
    return send_from_directory(TRANSCRIPTS_DIR, filename, as_attachment=True)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=False)
