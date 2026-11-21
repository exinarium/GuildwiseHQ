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

Every H.264 encode runs `AOM_VIDEO_ENCODE_THREADS` threads (default 4, lowered to the machine's cores; a missing or
invalid value uses 4), and each scene segment is decoded with one thread in the final encode, so peak memory does not grow
with the core count. `render.log` (and the worker log, with the post and render id) records the count once per render.
Each scene still costs about 70 MB of peak memory in the final encode: a typical 10 to 30 scene video peaks at 1.4 to
2.9 GB, and very long scripts (over about 45 scenes) need more than 4 GB.

## Needs

The voice and a static ffmpeg: `e2e/video/setup-voice.sh` (installs into `~/.cache/aom-video`, `AOM_VIDEO_HOME`).
Playwright's Chromium (`playwright install chromium`, or `AOM_CHROMIUM_PATH`). Fonts: Liberation Sans or Inter on the
machine. `AOM_FFMPEG` picks another ffmpeg, `AOM_MEDIA_VIDEOS_DIR` another folder of help videos, `--silent` renders with
silent placeholder audio when the voice is missing (smoke tests only).

`checkReelsFile(file)` (`packages/video/src/reels.ts`) checks a rendered MP4 against Instagram's Reels rules with that ffmpeg (no ffprobe needed); the publish sweep runs it after Instagram refuses a file.

## Worker roles

The video worker (`node dist/video-worker.mjs --loop`) has two halves, picked with `AOM_VIDEO_ROLE`:

| Role | Does | Heartbeat |
| --- | --- | --- |
| `render` | claims and renders one video at a time (needs Chromium, ffmpeg, the voice; the renderer is loaded only here) | `video_worker_render` |
| `publish` | render rows, the missed-slot watch, destination rows, uploads and slot posts, re-checks, cleanup | `video_worker_publish` |
| `all` (default) | both, as a single container always did | both |

`GET /api/platform/video/status` reports `render` and `publish` (`{ running, lastSeen, version, outdated }` each, see "Worker
version" below) and `serverVersion`; `worker` stays as the combined view (running only when both are).

Use it when the machine that publishes cannot render (for example a VPS without AVX): run `AOM_VIDEO_ROLE=publish` there and render on a machine that can, with the remote render worker below. The renderer never needs the database.

## Remote render worker (render job API)

A render worker on another machine has no database access and no shared volume. It talks to the server over HTTPS only. The older DB-connected remote worker and the push endpoint are gone: `AOM_VIDEO_PUSH_URL` makes `video-worker` refuse to start (the app only logs a warning), and `AOM_VIDEO_WORKER_TOKEN` only switches the old push endpoint on; it is no longer a credential.

**Token.** In Platform, Video, Settings, **Render workers**, add a worker. The render worker token is shown once. You can revoke it; the card shows last seen, network address, version and an encoder badge. Adding and revoking ask **Confirm it's you**.

**Run it.**

```
node apps/server/dist/video-worker.mjs --remote
```

| Key | Meaning |
| --- | --- |
| `AOM_RENDER_SERVER_URL` | the server's address; must be https (loopback excepted) |
| `AOM_RENDER_WORKER_TOKEN_FILE` | file holding the token (preferred) |
| `AOM_RENDER_WORKER_TOKEN` | the token itself, if no file |
| `AOM_VIDEO_DIR` | scratch folder for renders |
| `AOM_VIDEO_ENCODE_THREADS` | H.264 threads (see above) |
| `AOM_VIDEO_GPU` | `off`, `require`, or unset for automatic |
| `AOM_FFMPEG_GPU` | path of the NVENC ffmpeg |

**What it refuses.** The worker will not start with `DATABASE_URL` or `AOM_SECRET_KEY` set, with a plain http server address, or with `NODE_TLS_REJECT_UNAUTHORIZED=0`. It receives only the script to render and short-lived signed upload links; the server does every database write.

**Version check.** The worker-version rules below apply to this worker as well.

### GPU (NVENC)

The remote worker image carries a second ffmpeg with NVENC at `/opt/ffmpeg-gpu/bin/ffmpeg`. At start the worker runs a 3 second test encode. For it to pass, the host needs:

- the NVIDIA driver and the NVIDIA container toolkit (runtime);
- the host package `libnvidia-encode-<driver>` matching the driver (for example `libnvidia-encode-595`);
- the container started with `--gpus all`.

If any of that fails, the worker renders on the CPU, and that is reported, not hidden: a warning badge with the reason on the Render workers card, a callout on the Video page, and one mail to the super admins per worker per 24 hours. If NVENC fails during a render, that render falls back to the CPU (`cpu_fallback`). With `AOM_VIDEO_GPU=require` the worker does not fall back; `off` never uses the GPU. A mail also goes out (once per 24 hours) when no render worker was seen for 30 minutes while renders wait.

The in-process worker (`video-worker --loop`, the default for self-hosters) stays CPU-only. For the hosted service the render worker runs on a separate machine with `deploy/render-worker/render-worker.sh install|start|stop|restart|status`.

**Worker version.** A worker must not be older than the server it renders for:

- The app records its application version (the newest dated release in its bundled `CHANGELOG.md`) at boot as the platform
  setting `server_version`. Every heartbeat carries the worker's own version (`video_worker_<role>` gets `version`), and so does
  every request to the render job API (`x-worker-version`).
- `GET /api/platform/video/status` reports `version` and `outdated` per role and `serverVersion`. A worker older than the server,
  or one that reports no version (a build from before version reporting), is `outdated`; an equal or newer one is not. The
  Video page shows each worker's version, an "outdated" badge and a "Video worker out of date" problem with both versions, and
  the watch mails the super-admins once per worker version and server version.
- An outdated render worker claims no render: it logs `video worker <v> is older than server <v>; update the worker` once and
  keeps beating. A request from an outdated worker (or one without the header) gets `409 worker_outdated` with the same message;
  the render goes back to the queue without counting the attempt and waits 10 minutes, unless a current worker asks first.
- Update the worker together with the server. Once an updated worker beats, the flag clears and it renders again with no manual
  step. There is no override. A worker from before version reporting that writes to the shared volume (no push) cannot be
  refused, only flagged.

## Tests

`cd packages/shared && npx vitest run test/video.test.ts`; `cd packages/video && npx vitest run` (the render smoke test
runs with `AOM_VIDEO_RENDER_TEST=1` and the voice installed); `apps/server/test/video-clips.test.ts`.
