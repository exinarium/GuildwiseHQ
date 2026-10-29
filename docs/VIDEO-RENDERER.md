# Video renderer (`@aom/video`)

Renders a faceless video from a script: narration in the Kokoro `af_heart` voice (the voice of the help videos, same
speech cache), scene cards, clips of the help videos, captions, a thumbnail and a YouTube description. Nothing here
uploads anything. The review flow, the queue and the YouTube upload build on `renderScript`: see docs/BLOG-API.md "YouTube" (`apps/server/src/video/sweep.ts`, started by `video-worker --loop`, compose profile `video`).

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
- `apps/server/src/video-worker.ts` (bundled to `dist/video-worker.mjs`): the CLI below and `--loop`, the queue worker (claims a render, uploads approved videos, heartbeat, clean-up).

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

## Worker roles and the artifact push

The video worker (`node dist/video-worker.mjs --loop`) has two halves, picked with `AOM_VIDEO_ROLE`:

| Role | Does | Heartbeat |
| --- | --- | --- |
| `render` | claims and renders one video at a time (needs Chromium, ffmpeg, the voice; the renderer is loaded only here) | `video_worker_render` |
| `publish` | render rows, the missed-slot watch, destination rows, uploads and slot posts, re-checks, cleanup | `video_worker_publish` |
| `all` (default) | both, as a single container always did | both |

`GET /api/platform/video/status` reports `render` and `publish` (`{ running, lastSeen }` each); `worker` stays as the combined
view (running only when both are).

Use it when the machine that publishes cannot render (for example a VPS without AVX): run `AOM_VIDEO_ROLE=publish` there and
`AOM_VIDEO_ROLE=render` on a machine that can, both on the same database.

**Push.** A render worker that cannot share the video volume pushes every finished file over HTTPS instead:

- Render worker: `AOM_VIDEO_PUSH_URL=https://hq.example.com` and `AOM_VIDEO_WORKER_TOKEN=<secret>`. After rendering it does
  `PUT <url>/api/worker/video/renders/<renderId>/files/<name>` for each artifact (`video.mp4` or `short.mp4`, `captions.vtt`,
  `captions.srt`, `thumb.png`, `script.json`, `description.txt`, `render.log`) with `Authorization: Bearer <token>`,
  `x-content-sha256` and `content-length`, retrying with backoff (2 s, 10 s, 30 s, 90 s). The render stays `rendering` until every
  file is acknowledged, then becomes `rendered` and the local copy is deleted (leftovers of a crash older than a day are removed
  by the render worker). If the pushes keep failing, the attempt counts like a failed render (3 attempts). Without
  `AOM_VIDEO_PUSH_URL` the files are written to `AOM_VIDEO_DIR` as before.
- Receiving side: `AOM_VIDEO_WORKER_TOKEN` (at least 24 characters) switches the endpoint on; without it the endpoint does not
  exist (404). The body is streamed to a temp file in `AOM_VIDEO_DIR/<postId>/<revision>/`, its size and sha256 are checked
  (400 on a mismatch, 413 over the limit: `AOM_VIDEO_MAX_BYTES` for the MP4, 32 MB for the other files), and it is renamed into
  place. Only the fixed artifact names are accepted and only for a render that is `rendering`. A wrong token is a 401.
- Where it runs: the app mounts the volume read-only, so the **publish worker** serves the same route on its own small server
  (`AOM_VIDEO_WORKER_PORT`, default 4610) when `AOM_VIDEO_WORKER_TOKEN` is set. The reverse proxy must send
  `/api/worker/video/*` to the worker: `deploy/Caddyfile` does (to `video-worker:4610`); with nginx on the host add
  `location /api/worker/video/ { proxy_pass http://127.0.0.1:4610; client_max_body_size 0; proxy_request_buffering off; }`
  (publish the port to 127.0.0.1 in compose). If the app's own volume is writable, setting the token on the app serves the
  same route there instead.
- A video whose file is not (yet) on the publish machine waits ("waiting for the video file", retried every minute) until its
  slot has passed, instead of failing.

## Tests

`cd packages/shared && npx vitest run test/video.test.ts`; `cd packages/video && npx vitest run` (the render smoke test
runs with `AOM_VIDEO_RENDER_TEST=1` and the voice installed); `apps/server/test/video-clips.test.ts`.
