#!/usr/bin/env bash
# One-time setup of the offline voice for the help videos (needs network once, then none).
# Default engine: Kokoro-82M through kokoro-onnx (CPU, ONNX Runtime; the espeak-ng library comes inside the
# espeakng-loader wheel, so no system packages), voice af_heart. Also installs a static ffmpeg (VP9 + Opus).
#   AOM_VIDEO_HOME  where it goes (default ~/.cache/aom-video)
#   AOM_VIDEO_TTS   kokoro (default) or piper (the old voice, en_GB-cori-high; AOM_VIDEO_VOICE picks another Piper voice)
# Safe to run again: finished steps are skipped, downloads are checked against pinned SHA-256 sums.
set -euo pipefail
HOME_DIR="${AOM_VIDEO_HOME:-$HOME/.cache/aom-video}"
TTS="${AOM_VIDEO_TTS:-kokoro}"
KOKORO_ONNX_VERSION=0.6.1
KOKORO_PYTHON=3.12   # kokoro-onnx supports 3.10 to 3.13; uv fetches this build if the machine has another
MODEL_URL=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
MODEL_SHA=7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5
VOICES_SHA=bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d
mkdir -p "$HOME_DIR"

# static ffmpeg (and, for the old engine, Piper) in the plain venv
[ -x "$HOME_DIR/venv/bin/python" ] || python3 -m venv "$HOME_DIR/venv"
"$HOME_DIR/venv/bin/pip" install -q imageio-ffmpeg uv

fetch() { # file url sha256
  if [ -s "$1" ] && echo "$3  $1" | sha256sum -c --quiet - 2>/dev/null; then return; fi
  curl -fsSL -o "$1.part" "$2"
  echo "$3  $1.part" | sha256sum -c --quiet - || { echo "checksum mismatch for $2" >&2; rm -f "$1.part"; exit 1; }
  mv "$1.part" "$1"
}

if [ "$TTS" = piper ]; then
  VOICE="${AOM_VIDEO_VOICE:-en_GB-cori-high}"
  mkdir -p "$HOME_DIR/voices"
  "$HOME_DIR/venv/bin/pip" install -q piper-tts
  lang="${VOICE%%-*}"; name="${VOICE#*-}"; name="${name%-*}"; quality="${VOICE##*-}"
  base="https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang%%_*}/$lang/$name/$quality/$VOICE"
  for ext in onnx onnx.json; do
    [ -s "$HOME_DIR/voices/$VOICE.$ext" ] || curl -fsSL -o "$HOME_DIR/voices/$VOICE.$ext" "$base.$ext"
  done
  echo "voice ready (piper): $HOME_DIR/voices/$VOICE.onnx"
  exit 0
fi

KV="$HOME_DIR/kokoro-venv"
if [ ! -x "$KV/bin/python" ]; then
  "$HOME_DIR/venv/bin/uv" venv -q --python "$KOKORO_PYTHON" "$KV"
fi
"$HOME_DIR/venv/bin/uv" pip install -q --python "$KV/bin/python" "kokoro-onnx==$KOKORO_ONNX_VERSION"
mkdir -p "$HOME_DIR/kokoro"
fetch "$HOME_DIR/kokoro/kokoro-v1.0.onnx" "$MODEL_URL/kokoro-v1.0.onnx" "$MODEL_SHA"
fetch "$HOME_DIR/kokoro/voices-v1.0.bin" "$MODEL_URL/voices-v1.0.bin" "$VOICES_SHA"
echo "voice ready (kokoro af_heart): $HOME_DIR/kokoro"
