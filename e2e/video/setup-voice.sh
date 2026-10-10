#!/usr/bin/env bash
# One-time setup of the offline voice for the getting-started video (needs network once, then none).
# Installs Piper TTS and a static ffmpeg (VP9 + Opus) into a Python venv, and downloads a female English voice.
#   AOM_VIDEO_HOME  where it goes (default ~/.cache/aom-video)
#   AOM_VIDEO_VOICE the Piper voice (default en_GB-cori-high; en_GB-jenny_dioco-medium, en_US-amy-medium and en_US-lessac-medium also work)
set -euo pipefail
HOME_DIR="${AOM_VIDEO_HOME:-$HOME/.cache/aom-video}"
VOICE="${AOM_VIDEO_VOICE:-en_GB-cori-high}"
mkdir -p "$HOME_DIR/voices"
[ -x "$HOME_DIR/venv/bin/python" ] || python3 -m venv "$HOME_DIR/venv"
"$HOME_DIR/venv/bin/pip" install -q piper-tts imageio-ffmpeg
lang="${VOICE%%-*}"                       # en_GB
name="${VOICE#*-}"; name="${name%-*}"     # cori
quality="${VOICE##*-}"                    # medium
base="https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang%%_*}/$lang/$name/$quality/$VOICE"
for ext in onnx onnx.json; do
  [ -s "$HOME_DIR/voices/$VOICE.$ext" ] || curl -fsSL -o "$HOME_DIR/voices/$VOICE.$ext" "$base.$ext"
done
echo "voice ready: $HOME_DIR/voices/$VOICE.onnx"
