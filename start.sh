#!/usr/bin/env bash
# Starts Eco's paste-a-link web interface.
# Run this with:  ./start.sh
# Then open Chrome and go to: http://localhost:5050
# To stop it: come back to this terminal window and press Ctrl+C.
cd "$(dirname "$0")"
source venv/bin/activate
python3 webapp/app.py
