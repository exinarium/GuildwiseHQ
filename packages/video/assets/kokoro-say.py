"""Speaks text with Kokoro-82M (kokoro-onnx, CPU, offline): text on stdin, a 16-bit mono WAV file out.

  kokoro-say.py --out file.wav --voice af_heart --speed 1.0 --model kokoro-v1.0.onnx --voices voices-v1.0.bin < text
"""

import argparse
import sys
import wave

import numpy as np
from kokoro_onnx import Kokoro

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--voice", default="af_heart")
ap.add_argument("--speed", type=float, default=1.0)
ap.add_argument("--model", required=True)
ap.add_argument("--voices", required=True)
ap.add_argument("--lang", default="en-us")
a = ap.parse_args()

text = sys.stdin.read().strip()
if not text:
    sys.exit("no text on stdin")
samples, rate = Kokoro(a.model, a.voices).create(text, voice=a.voice, speed=a.speed, lang=a.lang)
pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
with wave.open(a.out, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(pcm.tobytes())
