# GWP-263: the server flags and refuses a video render worker older than itself

## Question

The workstation render worker stayed on 1.5.0 while the server went to 1.9.0, and nothing noticed. The server should know
which version each video worker runs, refuse to take renders from an older worker, show the problem in the status and the
UI, raise it through the watch's alert path, and recover by itself once the worker is updated.

Open points from planning:

- What is "the server's own application version", and where does it come from?
- Which routes are the "claim" and the "result push"?

## Findings

### 1. How the worker talks to the server today

- **The worker shares the database.** `video-worker --loop` calls `createApp(loadConfig(), { background: false })` and
  runs `videoTick` (`apps/server/src/video/sweep.ts`). The render **claim is not an HTTP route**. It is
  `claimRender()` in `sweep.ts:163`, an `UPDATE video_renders ... RETURNING` run by the worker process itself under an
  advisory lock. `renders.ts` only renders a script. It has no handout.
- **The heartbeat is not an HTTP route either.** `beatHeartbeat(ctx, role, info)` (`commands/video-posts.ts:191`)
  writes `{ at, ...info }` straight into `platform_settings` under `video_worker_render` / `video_worker_publish`. It is
  called by `videoTick` (`sweep.ts:1338-1339`), by the 30 s keep-alive inside `renderNext` (`sweep.ts:220`,
  `{ busy: 'render' }`) and by the publish side during uploads and posts (`sweep.ts:511, 596, 863`, `{ busy: ... }`).
  `workerHeartbeat()` reads `at` back and works out `running` from `VIDEO_POST_LIMITS.heartbeatStaleSeconds`.
- **The only HTTP route is the result push.** It is `PUT /api/worker/video/renders/:renderId/files/:name`
  (`video/push.ts`, `videoPushRoutes`). The publish worker serves it on its own small server, or the app serves it when
  its volume is writable. A render worker uses it when `AOM_VIDEO_PUSH_URL` is set, which is the workstation setup
  (`docs/VIDEO-RENDERER.md` "Worker roles and the artifact push", guildwise-cloud `docs/OWNER-SETUP.md` "Where the
  renders happen"). The client is `video/push-client.ts`. It treats any 4xx other than 408 and 429 as refused (no retry),
  and the render's error becomes `push of <name> refused: HTTP <status> <first 200 chars of body>`.
- `renderNext` marks the row `rendered` only after every push is acknowledged. A failed push goes to its `catch`, which
  writes `queued` (or `failed` after 3 attempts) with `WHERE id=$1 AND status='rendering' AND attempts=$5`. So if someone
  else has already moved the row out of `rendering`, the worker's failure write does nothing.

So "refuse to hand out jobs" cannot be a server-side gate on an HTTP claim, because there is no such claim. It has to be:
(a) a check inside the worker's own claim path, for every worker built from this change on; and (b) a server-side gate on
the push route, which also catches workers built **before** this change, because they send no version.

### 2. The server's own version

- Every `package.json` says `0.0.0`. The real product version only lives in `CHANGELOG.md`. The server build copies it
  beside the bundle (`apps/server/package.json` "build": `cp ../../CHANGELOG.md dist/release-notes/CHANGELOG.md`).
  `loadReleases()` (`apps/server/src/blog/releases.ts:336`) reads it and returns the dated releases newest first, so
  `loadReleases()[0]?.version` is the version of this build (`1.9.0` today). The public release pages and What's New
  already treat this value as the current release.
- The video worker is the same bundle: `dist/video-worker.mjs` sits next to `dist/release-notes/`, and so does the
  hosted image (guildwise-cloud `Dockerfile`: both the `video-worker` stage and the runtime stage copy
  `/out/server/dist`). So the worker reads its own version with the same call, and both sides always derive it from the
  same file. Nobody keeps a constant by hand, so the value cannot drift.
- A build without the file (a broken build, or some test setups) gives `null`.
- The app process does not publish its version anywhere today (`/api/health` returns only `{ ok, db }`). The render
  worker runs in another process, often on another machine, so it can only learn the server version through the shared
  database. The app has to write it there.

### 3. Semver helper

`compareSemver(a, b)` in `packages/shared/src/repo/component-rules.ts:175` is exported from `@aom/shared` (via
`repo/index.ts`). It returns `null` when either side is not semver, accepts an optional `v` prefix and ignores
`+build`. Release code already uses it. No new comparison is needed.

### 4. Where the flag shows

- `videoStatus()` (`video-posts.ts:532`) returns `render` / `publish` as `{ running, lastSeen }` and the combined
  `worker`. The wire type is `VideoStatusSchema` in `packages/shared/src/video/post.ts:261`. `render` and `publish` are
  already optional for older servers.
- Web: `workerStates()` in `apps/web/src/components/video/StatusStrip.tsx` feeds the strip's online/offline badges and
  `Problems` in `apps/web/src/pages/platform/PlatformVideo.tsx:55` (the "Video worker not running" callout). It is also
  used for `workerRunning` on `PostRow` (`PlatformVideo.tsx:601`). The existing web test is the `status strip` block in
  `apps/web/src/test/video-panel.test.tsx:761`.
- Alert path: `videoWatch()` (`sweep.ts:1092`) runs in the publish worker (`videoTick`) **and** in the app's scheduler
  (`scheduler/scheduler.ts:221`), so a dead worker cannot hide the problem. It sends mail through
  `alertVideoOnce(key, heading, reason)` (once per key, to the super-admins). "Render worker offline" is the
  `send('offline:<post>', ...)` call at `sweep.ts:1135`.

## Options

### A. Where the claim refusal lives

| Option | Stops a pre-change worker? | Stops a later outdated worker? | Cost and risk |
| --- | --- | --- | --- |
| A1. Worker checks itself before `claimRender` (reads the server version from the database) | no (old code has no check) | yes, it never claims, logs and keeps beating | small, no protocol change |
| A2. The server "parks" queued renders (pushes `lease_until` forward) while the render heartbeat says outdated | mostly (races between parks) | yes | changes the lease and backoff meaning, blocks a healthy second worker, flips with one heartbeat key per role. Fragile. |
| A3. Server gate on the push route (requires `x-worker-version`) | yes for a pushing worker: nothing it renders is accepted | yes | small. The old worker still claims and renders, but cannot deliver. |

**Chosen: A1 + A3.** A1 means that, from this build on, an outdated worker gets no render jobs at all. A3 is the real
server-side refusal and also covers the workstation worker that started all this: a 1.5.0 worker pushes without a
version, so the push is refused with the message and the render goes back to the queue unharmed. A2 was rejected because
the gain (also stopping the claim of the last pre-change build) does not justify reusing `lease_until` as a lock. Known
limit: a **pre-change** worker that writes to the shared volume directly (no push) cannot be stopped. It is still flagged
in the status, the UI and by mail. This happens only once, at the switch to this release.

### B. Reference version for "the server"

| Option | Notes |
| --- | --- |
| B1. Each process compares against its own build version | The render worker would compare against itself, which is useless. The push route would compare against the publish worker, not the server. |
| B2. The app writes its build version to `platform_settings` at boot, and every check reads it (falling back to the reader's own build version when nothing is recorded yet) | One source and one helper. Works across machines. No migration (the key/value table already exists). |

**Chosen: B2.** Key `server_version`, value `{ version: string | null, at }`. It is written once by `startServer`
(`apps/server/src/start.ts`), the entry of both the self-hosted and the hosted server
(guildwise-cloud `server/src/main.ts` calls it). The video worker also calls `createApp`, so the write must go in
`start.ts` and **not** in `createApp`. Otherwise every worker boot would overwrite the server's version with its own. A
rollback simply records the older version at its next boot.

### C. What happens to the render when the push is refused

| Option | Notes |
| --- | --- |
| C1. Leave it to the worker's `catch` | The old worker burns an attempt each time. After 3 the render is `failed` for good, and an updated worker would not pick it up again. That breaks "resumes by itself". |
| C2. The route puts the render back: `status='queued'`, `attempts=GREATEST(attempts-1,0)`, `error=<message>`, `lease_until=now+10 min` | The old worker's own failure write then does nothing (its `WHERE status='rendering'` no longer matches). The attempt is not counted. The 10-minute wait keeps an old worker from re-rendering in a tight loop. An up-to-date worker clears the wait when it claims (see 3.4), so recovery does not wait the 10 minutes. |

**Chosen: C2.**

### D. Override to let an outdated worker keep rendering

Not needed. An outdated worker's output is exactly what this card exists to stop, and recovery is automatic. **No new
environment variable and no override.**

## Design

### 1. Shared (`packages/shared`)

New file `packages/shared/src/video/worker-version.ts`, exported from `packages/shared/src/video/index.ts`:

```ts
import { compareSemver } from '../repo/component-rules.ts';

/** The header a render worker sends with every artifact push. */
export const WORKER_VERSION_HEADER = 'x-worker-version';
/** The error code of a push refused because the worker is older than the server. */
export const WORKER_OUTDATED_CODE = 'worker_outdated';
/** SQL LIKE pattern matching workerOutdatedMessage (the error a refused push leaves on the render row). */
export const WORKER_OUTDATED_LIKE = 'video worker % is older than server %';

/** A version as reported: trimmed, at most 60 characters of [0-9A-Za-z.+-]; anything else is "no version". */
export function cleanWorkerVersion(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^[0-9A-Za-z.+-]{1,60}$/.test(s) ? s : null;
}

/**
 * Outdated = the worker is older than the server. Missing or non-semver worker version counts as older.
 * If the server's own version is unknown (null or not semver), nothing can be compared and nobody is outdated.
 */
export function workerOutdated(worker: string | null | undefined, server: string | null | undefined): boolean {
  if (!server || compareSemver(server, server) === null) return false;
  if (!worker) return true;
  const c = compareSemver(worker, server);
  return c === null || c < 0;
}

export function workerOutdatedMessage(worker: string | null | undefined, server: string): string {
  return `video worker ${worker || '(no version)'} is older than server ${server}; update the worker`;
}
```

`VideoStatusSchema` (`packages/shared/src/video/post.ts`). All new fields are optional, so an older server still parses:

```ts
const VideoWorkerBeatSchema = z.object({
  running: z.boolean(),
  lastSeen: IsoTime.nullable(),
  /** The application version the worker reported with its last heartbeat (null: a build that does not report one). */
  version: z.string().nullable().optional(),
  /** The worker reported a version older than the server's, or none. */
  outdated: z.boolean().optional(),
});
// ...
render: VideoWorkerBeatSchema.optional(),
publish: VideoWorkerBeatSchema.optional(),
/** This server's application version (newest release in its CHANGELOG), the reference for `outdated`. */
serverVersion: z.string().nullable().optional(),
```

The combined `worker` stays `{ running, lastSeen }`, unchanged for older clients.

### 2. The build version (`apps/server/src/app-version.ts`, new)

```ts
import { loadReleases } from './blog/releases.ts';
/** This build's application version: the newest dated release in the bundled CHANGELOG.md; null without one. */
export const appVersion = (): string | null => loadReleases()[0]?.version ?? null;
```

The app, the push route and the worker all use this. Do not add a constant and do not read `package.json` (it says
`0.0.0`).

### 3. Server (`apps/server/src/commands/video-posts.ts`, section "worker heartbeat")

3.1 The server version record:

```ts
const SERVER_VERSION_KEY = 'server_version';
/** The app records its version at boot (start.ts) so workers on other machines can compare against it. */
export async function publishServerVersion(ctx: Ctx, version = appVersion()): Promise<void> {
  await putSetting(ctx, null, SERVER_VERSION_KEY, { version, at: ctx.clock.now().toISOString() });
}
/** The server's version: the recorded one; before any server recorded one, this build's own. */
export async function serverVersion(ctx: Ctx): Promise<string | null> {
  const r = await one(ctx.pool, 'SELECT value FROM platform_settings WHERE key=$1', [SERVER_VERSION_KEY]);
  if (!r) return appVersion();
  return cleanWorkerVersion((r.value as { version?: unknown }).version);
}
```

Always write the record, `null` included, so a build without a changelog does not leave an older record behind.
`apps/server/src/start.ts`: call `await publishServerVersion(app.ctx)` right after `createApp(...)`. Do **not** put it in
`createApp`, because `video-worker.ts` also calls `createApp`.

3.2 The heartbeat carries the version, and every write includes it:

```ts
export async function beatHeartbeat(
  ctx: Ctx, role: VideoWorkerRole, info: { busy?: string; version?: string | null } = {},
): Promise<void> {
  const version = 'version' in info ? (info.version ?? null) : appVersion();
  await putSetting(ctx, null, heartbeatKey(role), { at: ctx.clock.now().toISOString(), ...info, version });
}
```

**Trap:** the keep-alive beats (`renderNext`'s 30 s interval, the upload and post beats) replace the whole JSON. If any
of them leaves the version out, a current worker would flip to "outdated" in the middle of a render. Because the default
fills in `appVersion()`, every existing call site is covered. Pass `deps.version` where `SweepDeps` is in scope
(`videoTick`, `renderNext`'s interval) so tests can play an older worker.

3.3 Reading it back:

```ts
export async function workerHeartbeat(ctx: Ctx, role: VideoWorkerRole, server?: string | null)
  : Promise<{ running: boolean; lastSeen: string | null; version: string | null; outdated: boolean }> {
  // ... as today, plus
  const version = cleanWorkerVersion((r?.value as { version?: unknown } | undefined)?.version);
  const ref = server === undefined ? await serverVersion(ctx) : server;
  return { running, lastSeen: at, version, outdated: !!at && workerOutdated(version, ref) };
}
```

A role that has never beaten (`lastSeen` null) is "offline", not "outdated". A heartbeat from before this change has no
`version` key, so it reads as `null` and counts as outdated. Nothing throws. `videoStatus()` reads `serverVersion(ctx)`
once, passes it to both `workerHeartbeat` calls, and returns `serverVersion` at the top level and `version` and
`outdated` per role.

3.4 The worker's own claim check (`apps/server/src/video/sweep.ts`):

- `SweepDeps` gets `version?: string | null` ("this worker's application version; defaults to appVersion(); tests play
  an older worker with it").
- At the top of `renderNext` (this covers both the preview path and the scheduled path in `videoTick`):

```ts
const mine = deps.version !== undefined ? deps.version : appVersion();
const server = await serverVersion(ctx);
if (workerOutdated(mine, server)) {
  logOutdated(ctx, workerOutdatedMessage(mine, server as string)); // ctx.log.error, once per distinct message per process
  return false;                                                    // no claim; the heartbeat already went out in videoTick
}
clearOutdated(ctx); // log "video worker <v> is up to date again" once, if it had been refused
// renders a refused push put back with a 10-minute wait are free again now that a current worker asks
await exec(ctx.pool,
  `UPDATE video_renders SET lease_until=NULL
    WHERE status='queued' AND NOT library AND lease_until > $1 AND error LIKE $2`,
  [ctx.clock.now(), WORKER_OUTDATED_LIKE]);
const r = await claimRender(ctx, previewsOnly);
```

  Keep the "last logged message" in a module-level variable. It must not spam the log on every 15-second tick.
- `renderNext`'s 30 s keep-alive: `beatHeartbeat(ctx, 'render', { busy: 'render', version: mine })`.
- `videoTick`: `beatHeartbeat(ctx, role, deps.version !== undefined ? { version: deps.version } : {})` for each role it
  runs.
- The push: pass the version to the client: `pushArtifacts({ baseUrl, token, version: mine }, r.id, files, deps.push)`.

3.5 The push client (`apps/server/src/video/push-client.ts`): `PushTarget` gets `version?: string | null`. When it is set,
send `[WORKER_VERSION_HEADER]: version` with each PUT. Nothing else changes, because the existing "4xx is refused, no
retry" rule already does the right thing.

3.6 The push route (`apps/server/src/video/push.ts`, `videoPushRoutes`): add the gate **after** the token check (never
show versions to an unauthenticated caller) and after the name/id validation, **before** reading the body:

```ts
const worker = cleanWorkerVersion(req.headers[WORKER_VERSION_HEADER]);
const server = await serverVersion(ctx);
if (workerOutdated(worker, server)) {
  const message = workerOutdatedMessage(worker, server as string);
  // the attempt does not count, and an old worker does not re-render in a tight loop
  await exec(ctx.pool,
    `UPDATE video_renders SET status='queued', attempts=GREATEST(attempts-1,0), error=$2, lease_until=$3
      WHERE id=$1 AND status='rendering' AND NOT library`,
    [renderId, message, new Date(ctx.clock.now().getTime() + 10 * 60_000)]);
  ctx.log.warn({ renderId, worker, server }, message);
  throw new HttpError(409, WORKER_OUTDATED_CODE, message);
}
```

- 409 is a 4xx that `pushFile` does not retry. The worker's error then reads
  `push of captions.vtt refused: HTTP 409 {"error":{"code":"worker_outdated","message":"video worker 1.5.0 is older than server 1.9.0; update the worker"}}`.
  The whole message fits in the client's 200-character excerpt. A **1.5.0 worker** logs exactly that through its existing
  `ctx.log.warn({ err }, 'video render failed')`, which satisfies "the worker logs that error" with no change to old
  code.
- Make sure `startPushServer`'s error handler returns `{ error: { code, message } }` for an `HttpError` (it does today),
  and so does the app's handler.
- Do not touch the token check, `fastifyTrustProxy` or the route path.

3.7 The watch (`sweep.ts`, `videoWatch`, after section 2 "render worker offline / render failed"):

```ts
// 2b. a worker older than the server (same path as "offline": one mail per worker version / server version pair)
const server = await serverVersion(ctx);
for (const role of ['render', 'publish'] as const) {
  const b = await workerHeartbeat(ctx, role, server);
  if (!b.running || !b.outdated || !server) continue;
  await send(
    `outdated:${role}:${b.version ?? 'none'}:${server}`,
    `The video ${role} worker is out of date`,
    `${workerOutdatedMessage(b.version, server)}. ${role === 'render'
      ? 'Until it is updated it renders nothing and the server refuses its files, so scheduled videos wait and may slip.'
      : 'It runs older upload and posting code than the server.'} Update the worker image and restart it; rendering resumes by itself on its next heartbeat.`,
  );
}
```

Leave the existing `alive` and "offline" logic alone. The check runs whenever the watch runs (video active), with no
pending post needed. Because the key holds both versions, the alert is sent again after each new release the worker
misses.

### 4. Web (`apps/web`)

- `StatusStrip.tsx`, `WorkerState`: add `version: string | null`, `outdated: boolean` and `serverVersion: string | null`.
  `workerStates(status)` takes `Pick<VideoStatus, 'worker' | 'render' | 'publish' | 'serverVersion'>` and fills them from
  `render` / `publish`. The old combined `worker` view gives `version: null, outdated: false`, so an older server never
  shows a false flag.
- The strip: after the online/offline badge, show the version as **visible text** (for example `v1.9.0`), and when
  `running && outdated` show a warning `Badge` "outdated". Its accessible name or nearby text must carry both versions.
  Do not rely on a `title` tooltip alone, because touch devices never show it (standing order "design: all devices,
  including touch"). Keep it in the existing wrapping flex row so it wraps on a phone.
- `PlatformVideo.tsx` `Problems`: a new callout, after the "not running" one,
  `<Callout tone="danger" title="Video worker out of date" role="alert" data-testid="video-worker-outdated">`, with one
  line per worker where `running && outdated`. For example: "Render worker 1.5.0 is older than the server 1.9.0." (or
  "Render worker reports no version (a build from before version reporting) and is older than the server 1.9.0."),
  followed by the effect (render: "It renders nothing and the server refuses its files, so scheduled videos wait and may
  slip." publish: "It runs older upload and posting code than the server.") and what to do: "Update the worker image to
  1.9.0 or newer and restart it; rendering resumes by itself on its next heartbeat." A worker that is offline keeps the
  existing offline line and is not listed as outdated too.
- All versions come from the status response. The browser's own `__APP_VERSION__` is not used.
- Leave `workerRunning` (`PlatformVideo.tsx:601`) unchanged. An outdated worker is running, and the Problems callout
  explains why nothing renders.

### 5. Docs

`docs/VIDEO-RENDERER.md` "Worker roles and the artifact push": the heartbeat carries `version`; the status reports
`version`, `outdated` and `serverVersion`; the push requires `x-worker-version`, and an older or missing version gets 409
`worker_outdated` and the render goes back to the queue; the worker does not claim while outdated; the server records
`server_version` at boot; there is no override. In `docs/BLOG-API.md` line 600 (the status row), add "worker versions".
Add a `CHANGELOG.md` `## [Unreleased]` entry (Changed or Added) with the upgrade note: **update the render worker
together with the server.** A worker from before this release is refused until it is updated. The release-step side
belongs to the sibling card GWP-264 (same group).

## Data model

No migration. Two `platform_settings` values:

- `video_worker_<role>`: `{ at, busy?, version: string | null }` (`version` is new; old rows lack it and read as `null`).
- `server_version` (new): `{ version: string | null, at }`.

A refused push leaves `video_renders.error` = the outdated message and `lease_until` = now + 10 min on a `queued` row.

## Risks and traps

1. **Heartbeat overwrite** (3.2): every `beatHeartbeat` write must carry the version, or a current worker flaps to
   outdated. The default argument handles it. Test it with a keep-alive style call
   (`beatHeartbeat(ctx, 'render', { busy: 'render' })` keeps the version).
2. **Existing push tests** (`video-roles.test.ts` "push endpoint") send no version header. Once the gate is in, they get
   409. Give the `put` helper the header with the server's version, and have `clean()` also delete `server_version` and
   `video_alert:outdated:%`. The "render worker pushes" tests keep passing because the worker and the server derive the
   version from the same repository CHANGELOG in one process.
3. **Tests must not hard-code the repository's release.** `appVersion()` in tests reads the repository CHANGELOG, which
   changes every release. Write `server_version` explicitly (`publishServerVersion(ctx, '2.0.0')`) and give the worker
   `deps.version` / the header relative to that (`'1.5.0'`, `null`, `'2.0.0'`, `'2.1.0'`). Never rely on the repository
   value.
4. **Rollout order:** this is the first release where a worker without a version is refused. A workstation worker that
   is not updated with the server stops delivering, which is intended. Say so in the CHANGELOG, and GWP-264 puts it in
   the release steps.
5. **A pre-change worker on the shared volume (no push) cannot be refused** (see A). It is flagged and mailed. Name this
   in the handoff as a known limit.
6. **Late push from a reclaimed lease** (rare, the lease is 40 min): if a current worker has re-claimed the same render,
   a late push from an old worker puts it back in the queue. The current worker's `rendered` write then does nothing and
   the render runs again. The cost is time, not data.
7. Keep the core free of hosted names: the UI and mail say "the worker image", not the hosted container name.

## Acceptance criteria and the design

| AC | Where it is met | Test |
| --- | --- | --- |
| Every heartbeat carries the worker's version; stored per role | 3.2 `beatHeartbeat` (default `appVersion()`), `videoTick`/keep-alive pass `deps.version`; stored in `video_worker_<role>` | server: tick with `deps.version` then read the row / status; a keep-alive style beat keeps the version |
| Older or missing version shown as outdated in videoStatus and the strip/Problems, with both versions | 3.3 `workerHeartbeat`/`videoStatus` (`version`, `outdated`, `serverVersion`); 4 strip badge + Problems callout | server: status for `1.5.0` and `null` vs server `2.0.0` → `outdated: true`, both versions present; web: strip + Problems render the outdated state with both numbers |
| While outdated: no render jobs, pushed files rejected with both versions, worker logs it | 3.4 self-check before `claimRender` (logs), 3.6 route 409 `worker_outdated` + requeue | `renderNext` with `deps.version '1.5.0'` and `null` returns false, row stays `queued` with attempts 0, log has the message; push with header `1.5.0` and with none → 409, message names both, row back to `queued`, attempts not counted, no file written; `renderNext` through the push client with an outdated header → the render error contains the message |
| After an update, the next heartbeat clears the flag and jobs flow, no manual step | 3.3 is derived from the latest heartbeat; 3.4 clears the 10-minute wait on outdated-requeued rows and claims | outdated tick → status outdated; then tick with `deps.version = server` → status not outdated and `rendered: true` in the same tick, including a row a refused push had put back |
| The watch raises an outdated worker through the offline path | 3.7 `send('outdated:<role>:<v>:<server>', ...)` via `alertVideoOnce` | `videoWatch` with a running outdated render heartbeat → one mail to the super-admin (CaptureMailer), not repeated on the next run; none for an equal or newer one |
| Same or newer version behaves as today | `workerOutdated` returns false for `c >= 0`; no gate, no flag | status with `2.0.0` and `2.1.0` → `outdated: false`, version shown; `renderNext` renders; push with header `2.0.0`/`2.1.0` → 200 |
| Tests cover older, missing, equal, newer for refuse and flag | sections above | shared unit test of `workerOutdated` (older, missing, equal, newer, non-semver worker, unknown server, `v` prefix, `+build`); server tests in `video-roles.test.ts`; web test in `video-panel.test.tsx` "status strip" |

## Files to change

- `packages/shared/src/video/worker-version.ts` (new), `packages/shared/src/video/index.ts`,
  `packages/shared/src/video/post.ts`; test `packages/shared/test/video-worker-version.test.ts` (new).
- `apps/server/src/app-version.ts` (new), `apps/server/src/start.ts`, `apps/server/src/commands/video-posts.ts`,
  `apps/server/src/video/sweep.ts`, `apps/server/src/video/push.ts`, `apps/server/src/video/push-client.ts`.
  `apps/server/src/video-worker.ts` needs no change (the loop calls `videoTick`, which now sends the version); update its
  header comment to say the heartbeat carries the version and an outdated worker claims nothing.
- `apps/web/src/components/video/StatusStrip.tsx`, `apps/web/src/pages/platform/PlatformVideo.tsx`.
- Tests: `apps/server/test/video-roles.test.ts` (new `describe('worker version')` + header in the push helper),
  `apps/web/src/test/video-panel.test.tsx` ("status strip" block).
- Docs: `docs/VIDEO-RENDERER.md`, `docs/BLOG-API.md`, `CHANGELOG.md` (Unreleased).

`renders.ts` needs no change (it has no handout).

## Testing notes for the builder

- Server tests need Postgres (CLAUDE.md "Running the tests"; use your own `aom_test_<card>` database). Run
  `test/video-roles.test.ts`, `test/video-encode-threads.test.ts` and `test/video-youtube.test.ts` (they call
  `renderNext` / `videoTick` and must keep passing). Shared: `npx vitest run test/video-worker-version.test.ts`, plus the
  existing `test/video.test.ts`. Web: `npx vitest run src/test/video-panel.test.tsx`. Then `pnpm -r typecheck` and
  `npx biome check`.
- Left for testers / DevOps: the manual workstation check (current server plus an older worker image; check the flag, the
  refused files, then update and check that rendering resumes) and any e2e.
