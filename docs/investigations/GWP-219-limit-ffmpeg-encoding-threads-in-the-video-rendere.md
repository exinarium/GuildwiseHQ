# GWP-219: Limit ffmpeg encoding threads in the video renderer

## Question

On a 16-core host the final libx264 encode in `renderVideo` grew past the 4 GB render-container limit and was OOM-killed.
How do we bound the renderer's memory with thread settings only (same codec, preset, CRF, pixel format, resolution, frame
rate, audio), make the thread count configurable from the server, and log it once per render?

## Findings

### Call sites (packages/video)

| Call site | Encoder | Runs in production | Decision |
| --- | --- | --- | --- |
| `encodeArgs` / final encode, `render.ts:87`, run at `render.ts:299-308` | libx264 `medium` CRF 20 + AAC, N segment inputs, xfade chain | yes, every render | **cap** the encoder (`-threads n`, `-x264-params threads=n`) **and** the segment decoders (`-threads 1` before each segment `-i`) |
| per-scene segment encode, inline `enc` array `render.ts:211-226` (both the card and the clip branch) | libx264 `veryfast` CRF 12 | yes, once per scene, one at a time | **cap** the encoder (`-threads n`, `-x264-params threads=n`) |
| `toMp4`, `ffmpeg.ts:100` | libx264 `slow` CRF 23 | no: only `e2e/video/harness.ts` (help-video recorder) calls it | **cap** anyway (card requirement 2); callers unchanged |
| `mux`, `ffmpeg.ts:51` | libvpx-vp9 + libopus | recorder only | **leave**: not libx264 |
| `probeDuration`, `findFfmpeg` | none (`-i` / `-encoders` only) | yes | **leave**: no encode |
| `runFfmpeg` | generic runner | yes | **leave**: arguments come from the callers above |

`audio.ts` (`joinWavs`, `writeSilentWav`) and `captions.ts` do not run ffmpeg. No stream-copy step exists in packages/video
today, so none is touched.

### Where the memory goes (measured)

Measured on this workstation (16 cores, ffmpeg 8.0.1, libx264 core 165) with ffmpeg's own `-benchmark` (`maxrss`). Each
run is the exact `encodeArgs` command shape: N 1080x1920 30 fps segments (3 s each, `veryfast` CRF 12, as the renderer
writes them) cross-faded with the same 0.3 s `xfade` chain, a narration WAV, libx264 high `medium` CRF 20, AAC 160k.

| N scenes | Encoder threads | Decoder threads (per segment input) | Filter threads | Peak RSS | Wall |
| --- | --- | --- | --- | --- | --- |
| 30 | auto (x264 picked 24, lookahead 4) | auto | auto | **6.61 GB** | 14 s |
| 30 | 4 | auto | auto | 6.19 GB | 26 s |
| 30 | 4 | 4 | auto | 3.62 GB | 24 s |
| 30 | 4 | **1** | auto | **2.86 GB** | 23 s |
| 30 | 4 | 1 | 4 (`-filter_complex_threads`) | 2.79 GB | 23 s |
| 10 | 4 | 1 | auto | 1.40 GB | n/a |
| 60 | 4 | 1 | auto | 4.96 GB | 55 s |

Segment encode (one 8 s card scene, zoompan, 1080x1920): auto threads 767 MB / 1.3 s; 4 threads 350 MB / 1.6 s.

2-core host (`taskset -c 0,1`, 10 scenes): today x264 picks 3 threads, 1.53 GB, 26.2 s; capped (encoder 2, decoders 1)
1.30 GB, 26.2 s. **No slowdown.**

ffprobe of the 30-scene output before and after: h264 High, 1080x1920, yuv420p, 30/1, AAC LC 48 kHz stereo, duration
81.366667 s in both. Identical stream properties.

What this shows:

1. **The encoder cap alone is not enough.** libx264's own threads account for only ~0.4 GB of the 6.6 GB. Most of the
   core-count-dependent memory is in the **decoders**: the final encode opens every segment as its own input, and ffmpeg's
   H.264 decoder picks frame threads from the core count for each one, so memory is roughly scenes x cores. A per-input
   `-threads 1` cuts 6.2 GB to 2.9 GB at 30 scenes, with no loss of speed (the encoder is the bottleneck; a single-threaded
   decode of these segments runs far faster than x264 `medium`).
2. **Filter threads do not matter** (~70 MB). Requirement 3 is conditional ("if the filter graph turns out to be a large
   part"); it is not, so `-filter_threads` / `-filter_complex_threads` are left out.
3. **Lookahead needs nothing extra.** x264 derives `lookahead_threads` as `threads / 6` (at least 1), so with `threads=n`
   it is already bounded (1 for n < 12). `rc-lookahead` is **not** changed: it alters rate control and therefore the
   picture, which requirement 6 forbids.
4. **Residual: memory still grows with the number of scenes**, about 70 MB per scene (ffmpeg keeps a few decoded 1080x1920
   frames queued for every open input). With all caps the 4 GB line is crossed at about 45 scenes; the schema allows up to
   80 cues (`VideoScriptSchema`, `cues.max(80)`), which would be ~6.3 GB. Typical scripts (the fixtures have 6 and 11 cues;
   10 to 30 scenes) stay at 1.4 to 2.9 GB. Removing this term needs a structural change (cross-fade in bounded batches),
   not a thread setting: out of scope here and raised as a follow-up (see Risks).

### Thread count, cores and containers

- `os.availableParallelism()` (Node 22) honours CPU affinity / cpusets, which is what libx264 itself sees. Neither it nor
  `os.cpus().length` sees a CFS quota (`docker --cpus=2`, the compose file's `cpus: 2`): inside such a container both report
  the host's cores. That is why the default must be a fixed number and not derived from the cores; the clamp only matters on
  small hosts. Use `availableParallelism()` for the clamp (it is right on `taskset`/`--cpuset-cpus` too).
- `-threads n` placed **before** an `-i` is a decoder option for that input; placed after the inputs it is the encoder's.
  `-x264-params threads=n` sets the same x264 parameter explicitly (the card asks for both).
- Different thread counts give a slightly different H.264 bitstream (x264 is deterministic per thread count, not across
  them). Codec, profile, preset, CRF, pixel format, size, frame rate, duration and audio are unchanged, which is what AC 6
  compares.

## Options compared

| Option | Memory at 30 scenes / 16 cores | Meets AC 4 for typical posts | Size |
| --- | --- | --- | --- |
| A. Encoder caps only (the card's literal minimum) | 6.2 GB | **no** | smallest |
| B. A + `-threads 1` per segment input of the final encode | 2.9 GB | yes (up to ~45 scenes) | +1 line |
| C. B + filter thread caps | 2.8 GB | yes | +2 lines, no real gain |
| D. B + cross-fade in batches of K segments | bounded for any length | yes, also 80 scenes | large, changes the pipeline (extra intermediate encode) |

## Recommendation

**Option B.** Encoder caps on every libx264 encode, plus a fixed `-threads 1` on each segment input of the final encode.
It is the smallest change that actually brings the failing case under 4 GB, it changes threading only, and it costs no
time on small hosts. Default **4** encoder threads (`DEFAULT_ENCODE_THREADS`): bounded memory everywhere, no slowdown on the
2-CPU production worker, about 2x slower final encode on a 16-core host (14 s to 26 s for an 80 s Short) which is far inside
the 40-minute render lease. Option D goes to the backlog as a follow-up.

Environment variable name: **`AOM_VIDEO_ENCODE_THREADS`** (the card's `VIDEO_ENCODE_THREADS` was an example; every server
variable, including the other video ones, carries the `AOM_` prefix).

## Design

### packages/video/src/ffmpeg.ts

```ts
import { availableParallelism } from 'node:os';

/** libx264 threads when none (or an invalid number) is asked for: a fixed small number, so memory does not follow the core count. */
export const DEFAULT_ENCODE_THREADS = 4;

/** The encoder threads to use: `requested` if it is a whole number >= 1, else the default; never more than the cores. */
export function resolveEncodeThreads(requested?: number, cores: number = availableParallelism()): number {
  const n = Number.isInteger(requested) && (requested as number) >= 1 ? (requested as number) : DEFAULT_ENCODE_THREADS;
  return Math.max(1, Math.min(n, Math.floor(cores) || 1));
}

/** The libx264 thread arguments (output options). */
export const x264ThreadArgs = (n: number): string[] => ['-threads', String(n), '-x264-params', `threads=${n}`];
```

`toMp4(src, dest, crf = '23', threads?: number)`: build the arguments with an exported `toMp4Args(src, dest, crf, threads)`
(pure, for the test) and insert `...x264ThreadArgs(resolveEncodeThreads(threads))` right after `'-crf', crf`. Every other
argument and the existing callers (`e2e/video/harness.ts`, the re-export in `e2e/video/voice.ts`) stay as they are; no e2e
file changes. `mux` is untouched.

### packages/video/src/render.ts

`RenderOptions` gains:

```ts
  /** libx264 threads of every encode: default DEFAULT_ENCODE_THREADS, never more than the host's cores. Bounds the encoder's memory. */
  encodeThreads?: number;
  /** Names the render in the log, e.g. `post <id> render <id>`. */
  renderLabel?: string;
```

`encodeArgs` gains `threads?: number` (default `DEFAULT_ENCODE_THREADS`, pure, no clamping, so existing callers and tests
keep working). Exact new argument list (today's list plus the bold parts; nothing reordered):

```
for each segment: **'-threads','1',** '-i', <seg>
'-i', audio, '-filter_complex', filter, '-map', '[vout]', '-map', '<N>:a',
'-c:v','libx264','-profile:v','high','-preset','medium','-crf',<crf>,'-pix_fmt','yuv420p','-r',<fps>,
**'-threads',<n>,'-x264-params','threads=<n>',**
'-c:a','aac','-b:a','160k','-ar','48000','-ac','2','-t',<seconds>, ...MP4_MUX_ARGS, out
```

Update the doc comment of `encodeArgs` to say why the decoders get one thread (one decoder per scene; their frame threads
were most of the memory).

New exported pure builder for the segment encode (replaces the inline `enc` array, same order, threads inserted before
`-frames:v`):

```ts
export function segmentEncodeArgs(o: { fps: number; frames: number; out: string; threads: number }): string[] {
  return ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(o.fps),
    ...x264ThreadArgs(o.threads), '-frames:v', String(o.frames), o.out];
}
```

The segment inputs (scene PNG, help-video clip) keep their decoders as they are: one segment runs at a time and it is not
the peak.

In `renderVideo`, right after `findFfmpeg` (before speech), once per render:

```ts
const threads = resolveEncodeThreads(opts.encodeThreads);
log(`encode threads: ${threads} (asked ${opts.encodeThreads ?? 'default'}, default ${DEFAULT_ENCODE_THREADS}, ` +
    `${availableParallelism()} cores)${opts.renderLabel ? `, ${opts.renderLabel}` : ''}`);
```

and pass `threads` to `segmentEncodeArgs` and to `encodeArgs`. The line lands in `render.log` and in `opts.log`.

### apps/server/src/config.ts

```ts
/** AOM_VIDEO_ENCODE_THREADS: a whole number >= 1, else undefined (the renderer's default applies). Never fails the boot. */
export function parseEncodeThreads(v: string | undefined): number | undefined {
  const s = v?.trim();
  return s && /^\d+$/.test(s) && Number(s) >= 1 ? Number(s) : undefined;
}
```

- EnvSchema, in the video block next to `AOM_VIDEO_MAX_BYTES`, with a doc comment:
  `AOM_VIDEO_ENCODE_THREADS: z.string().optional().transform(parseEncodeThreads),`
  Not `z.coerce.number().int().min(1)`: an invalid value must fall back to the default, not stop the server.
- `Config`: `videoEncodeThreads: number | undefined;` (doc: "AOM_VIDEO_ENCODE_THREADS; undefined = the renderer's default
  (4); clamped to the cores by the renderer").
- `loadConfig`: `videoEncodeThreads: e.AOM_VIDEO_ENCODE_THREADS,`.
- The default and the clamp live in packages/video only (one place); the server parses, it does not decide the number.

### apps/server/src/video/sweep.ts (the production path)

The `--loop` worker renders through `renderNext` -> `defaultRender` -> `renderScript`, not through the CLI, so this is
where the setting must be wired (the planning note only named video-worker.ts).

- `RenderFn` opts: `{ outDir: string; log: (l: string) => void; encodeThreads?: number; renderLabel?: string }`.
  Existing fakes in tests keep compiling (extra optional fields).
- `defaultRender`: `renderScript(script, { outDir: opts.outDir, log: opts.log, encodeThreads: opts.encodeThreads, renderLabel: opts.renderLabel })`.
- `renderNext` (line ~227):
  ```ts
  const out = await (deps.render ?? defaultRender)(script, {
    outDir,
    encodeThreads: ctx.config.videoEncodeThreads,
    renderLabel: `post ${r.post_id} render ${r.id}`,
    log: (l) => {
      lines.push(l);
      ctx.log.info({ postId: r.post_id, renderId: r.id }, `video render: ${l}`);
    },
  });
  ```
  Forwarding the renderer's lines to the worker log matters for AC 7: `render.log` is only written at the end of a render,
  so an OOM-killed render leaves no file; the container log keeps the `encode threads: n` line with the post and render id,
  and also shows which step was running when the process died. About eight lines per render.

### apps/server/src/video/renders.ts

No code change: `RenderScriptOptions extends Omit<RenderOptions, 'clips'>` and `renderScript` spreads `opts` into
`renderVideo`, so `encodeThreads` and `renderLabel` flow through. (Covered by the server test below.)

### apps/server/src/video-worker.ts (CLI `--render`)

Line ~70: add `encodeThreads: parseEncodeThreads(process.env.AOM_VIDEO_ENCODE_THREADS)` (imported from `./config.ts`, so the
variable is parsed by the one helper; `loadConfig()` is avoided here because it insists on `AOM_SECRET_KEY` under
`NODE_ENV=production`, which a one-off CLI render does not need) and `renderLabel: \`script ${values.render}\``.

### Docs

- `docs/SELF-HOSTING.md`, "YouTube videos" section, after the `AOM_VIDEO_MAX_BYTES` sentence:
  `AOM_VIDEO_ENCODE_THREADS` (worker only, default 4) caps the threads of each H.264 encode and keeps the render's memory the
  same on any machine; a value above the machine's cores is lowered to the cores, and a missing or invalid value (not a whole
  number, or below 1) uses 4. Raise it only on a large machine with memory to spare: memory grows with it. Note that the
  bundled compose file does not pass it through today, so the default applies there.
- `docs/VIDEO-RENDERER.md`, the output paragraph (line ~29) or "Needs": the same variable, and one sentence that each scene
  costs about 70 MB of peak memory in the final encode (very long scripts need more than 4 GB).

Do **not** edit `docker-compose.prod.yml` or any deploy file (card constraint). Passing the variable through compose is a
separate follow-up if wanted.

## Tests

New `packages/video/test/encode-threads.test.ts` (no ffmpeg needed):

1. `encodeArgs({..., threads: 4})`: the arguments after the last `-i <file>` contain `-threads 4` and `-x264-params threads=4`
   (search after `args.lastIndexOf('-i') + 2`, because the decoders also carry `-threads`); every segment `-i` is preceded by
   `-threads 1`; the narration input is not.
2. Snapshot: removing the threading pairs (`-threads x`, `-x264-params x`) from `encodeArgs(...)` yields exactly today's
   list (write today's array out literally in the test: codec, profile, preset, CRF, pix_fmt, `-r`, AAC 160k 48 kHz stereo,
   `-t`, `MP4_MUX_ARGS`, out).
3. `encodeArgs` without `threads` uses `DEFAULT_ENCODE_THREADS` (4).
4. `resolveEncodeThreads`: `(undefined, 16)` -> 4; `(3, 16)` -> 3; `(32, 16)` -> 16; `(4, 2)` -> 2 (default clamped too);
   `(0, 16)`, `(-1, 16)`, `(1.5, 16)`, `(NaN, 16)` -> 4.
5. `segmentEncodeArgs({fps: 30, frames: 90, out: 'seg.mp4', threads: 4})` equals today's segment list plus the two thread
   pairs before `-frames:v`.
6. `toMp4Args('a.webm', 'a.mp4', '23', 4)` contains `-threads 4` and `-x264-params threads=4` and keeps profile high,
   level 4.0, preset slow, CRF 23, AAC 128k.

The existing `packages/video/test/video.test.ts` needs no change (it calls `encodeArgs` without `threads`); keep it passing,
including the ffmpeg-backed "no elst atom" case, which now also proves ffmpeg accepts the new arguments when ffmpeg is present.

New `apps/server/test/video-encode-threads.test.ts`:

7. `parseEncodeThreads` / `loadConfig({...process.env, AOM_VIDEO_ENCODE_THREADS: v}).videoEncodeThreads`: unset and `''`
   -> undefined; `'3'` -> 3; `'64'` -> 64 (clamping is the renderer's job); `'0'`, `'-1'`, `'abc'`, `'1.5'` -> undefined, and
   `loadConfig` does not throw.
8. `renderScript` passes `encodeThreads` and `renderLabel` through to `renderVideo`: `vi.mock('@aom/video')` with a
   capturing `renderVideo`, call `renderScript(script, { outDir, catalog: [], encodeThreads: 3, renderLabel: 'x' })`.
9. `renderNext` passes `ctx.config.videoEncodeThreads` and `post <id> render <id>` to the render function: one case with
   `createTestApp({ env: { AOM_VIDEO_ENCODE_THREADS: '3' } })` and a capturing `RenderFn`, set up like
   `apps/server/test/video-roles.test.ts` (it needs the test database, as that suite does).

Manual / integration (tester or DevOps, results in the PR; not unit tests):

10. AC 4: on a >= 16-core host, run the render worker image with `docker run --memory=4g --memory-swap=4g` (no `--cpus`, so
    x264 would see all cores before the change) and render the post that failed on 12 Nov (`video-worker --render
    <script.json> --out <dir>`, script from `video_posts.script`). Record the peak from `cat
    /sys/fs/cgroup/memory.peak` in the container (or `docker stats`), the wall time, and the scene count from the
    `timeline: N scenes` line of `render.log`. Repeat with `AOM_VIDEO_ENCODE_THREADS=1` and `=8`.
11. AC 5: same with `--cpuset-cpus=0,1` (affinity, so both x264 before and the clamp after see 2 cores), previous build vs
    this build, compare the `encoded` timestamps in `render.log`.
12. AC 6: `ffprobe -show_entries stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,sample_rate,channels:format=duration`
    on one render before and after.
13. AC 7: the worker log and `render.log` show `encode threads: n ... post <id> render <id>` once.

## Acceptance criteria mapping

| AC | Design | Proof |
| --- | --- | --- |
| Final encode has `-threads n` and `-x264-params threads=n` | `encodeArgs` output options, `x264ThreadArgs` | tests 1-3 |
| Unset -> default, valid -> clamped, 0/negative/text -> default | `parseEncodeThreads` (server) + `resolveEncodeThreads` (package) | tests 4, 7 |
| Every other libx264 encode capped, stream copies unchanged, PR lists call sites | segment encode + `toMp4` capped; `mux` (VP9), `probeDuration`, `findFfmpeg` left; table in Findings | tests 5, 6; copy the call-site table into the PR |
| 16-core host, 4 GB, failing post completes, peak reported | encoder caps + `-threads 1` per segment input (6.6 GB -> 2.9 GB at 30 scenes, measured) | manual 10; see risk 1 |
| <= 2 cores, no more than ~10% slower | default clamped to the cores; decoders single-threaded | measured 26.2 s vs 26.2 s; manual 11 |
| Same codec, resolution, fps, pix_fmt, duration, streams | only threading arguments added | test 2 snapshot; measured ffprobe identical; manual 12 |
| Thread count logged once per render with id | `renderVideo` log line with `renderLabel`; `renderNext` forwards to the worker log with postId/renderId | manual 13 (test 9 can assert the line reaches the logger) |
| Variable documented with the other server variables | SELF-HOSTING.md and VIDEO-RENDERER.md | review |

## Risks

1. **Scripts with many scenes can still exceed 4 GB** (~70 MB per scene after the caps; ~45 scenes reach 4 GB, the schema
   allows 80). AC 4 is met for the failing post only if it has fewer than about 40 scenes; the tester should record the
   scene count with the peak. Bounding this needs the cross-fade rendered in batches (option D), a separate card. The 8 GB
   stopgap should not be lowered to 4 GB until that is decided.
2. Final encode about 2x slower on large hosts at the default 4 (measured 14 s -> 26 s for an 80 s Short on 16 cores).
   Acceptable against the 40-minute lease; owners with spare memory can raise the variable.
3. The bundled compose file lists the worker's variables explicitly, so `AOM_VIDEO_ENCODE_THREADS` set in `.env` does not
   reach the container until a pass-through line is added (deployment change, out of scope). The default 4 applies there,
   which is the point of the card.
4. Output bitstream differs slightly from today's (different x264 thread count); stream properties and quality settings
   are identical.
5. `-x264-params` needs an ffmpeg built with libx264, which `findFfmpeg(RENDER_ENCODERS)` already requires; the static
   imageio-ffmpeg build and distribution builds accept it.
