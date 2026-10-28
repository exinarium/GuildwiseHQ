# Video renderer (`@aom/video`)

Renders a faceless video from a script: narration in the Kokoro `af_heart` voice (the voice of the help videos, same
speech cache), scene cards, clips of the help videos, captions, a thumbnail and a YouTube description. Nothing here
uploads anything; the review flow and the YouTube upload build on `renderScript` later.

## Pieces

- `packages/shared/src/video`: `VideoScriptSchema` (scenes: title, points, quote, code, clip, image, outro; `long` or
  `short`; chapters; `meta` limits in `VIDEO_LIMITS`), `parseVideoScript(json, { clipSlugs })` (clip slugs, word range of
  the format, no demo data), `NARRATION_STYLE`, `PRONUNCIATIONS`, `speakable()` (what the voice reads: pronunciation map,
  "1.2.0" becomes "version one point two", numbers in words, no URLs) and `buildDescription()`.
- `packages/video`: `speak()` and the ffmpeg helpers (moved from `e2e/video/voice.ts`, which re-exports them),
  `buildTimeline()` (a cue starts after the earlier cues, each followed by 0.7 s; consecutive cues with the same scene
  share one scene), `renderVideo(script, opts)`.
- `apps/server/src/video`: `clips.ts` (the help video catalog from `media/videos/*.json`; a clip scene is a chapter or a
  `from`/`to` range of the MP4: trimmed, slowed to at least 0.8x, or its last frame held; audio dropped; branded frame) and
  `renders.ts` (`renderScript(script, opts)` validates, then renders).
- `apps/server/src/video-worker.ts` (bundled to `dist/video-worker.mjs`): for now a CLI.

## Render one script

```
pnpm --filter @aom/server build
node apps/server/dist/video-worker.mjs --render packages/video/test/fixtures/agents-long.json --out /tmp/out
node apps/server/dist/video-worker.mjs --list-clips
```

Output in `--out`: `video.mp4` (`short.mp4` for a Short: 1080x1920 with large burned-in captions), `captions.vtt`,
`captions.srt`, `thumb.png` (long only, 1280x720), `description.txt`, `script.json`, `render.log`. H.264 high 30 fps
CRF 20, AAC 48 kHz stereo, fast start; 0.3 s cross fades; slow zoom on cards.

## Needs

The voice and a static ffmpeg: `e2e/video/setup-voice.sh` (installs into `~/.cache/aom-video`, `AOM_VIDEO_HOME`).
Playwright's Chromium (`playwright install chromium`, or `AOM_CHROMIUM_PATH`). Fonts: Liberation Sans or Inter on the
machine. `AOM_FFMPEG` picks another ffmpeg, `AOM_MEDIA_VIDEOS_DIR` another folder of help videos, `--silent` renders with
silent placeholder audio when the voice is missing (smoke tests only).

## Tests

`cd packages/shared && npx vitest run test/video.test.ts`; `cd packages/video && npx vitest run` (the render smoke test
runs with `AOM_VIDEO_RENDER_TEST=1` and the voice installed); `apps/server/test/video-clips.test.ts`.
