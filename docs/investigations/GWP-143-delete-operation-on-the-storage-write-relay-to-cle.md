# GWP-143: Delete operation on the storage write relay, to clean up timed-out form uploads

Status: design, ready to build. Base: `release/1.6.0` at `f6b71d8d` (the card branch starts there).

## 1. The question

When a public form submission times out after some of its files were written to the firm's storage, and no answers
document was written, those files stay in the firm's storage. The card asks for a `storage.delete` operation through the
storage relay, a server sweep that removes those orphans with bounded retries, and a cleanup state on the desk's
submissions list. First step: record what already exists on `release/1.6.0`.

## 2. What already exists on release/1.6.0 (checked in the code)

| Area | State on release/1.6.0 | What this card does with it |
|---|---|---|
| `StorageConnector.delete(path, signal)` (`apps/runner/src/storage/types.ts:38`) | Exists. Documented as **best-effort**: used by `probe` and by `deleteRef` | Kept unchanged (write path, probe). A new, strict `deleteFile` is added next to it (section 4.3) |
| Local `delete` (`local.ts:114`) | Exists. `confineUnder(root, segments)` then `rm(force)`. Does not tell "deleted" from "not there". A NAS share that is not mounted would look like "not there" | Strict variant added |
| Vault `delete` (`vault.ts:81`) | Exists. An unsafe path is silently ignored (`return`). `rm(force)` with **no git commit**, so a non-local vault keeps the file in history and the next sync can bring it back. No check that the path is under the destination folder | Strict variant added, with commit |
| S3 `delete` (`s3.ts:155`) | Exists. 404 counts as OK. Never says "not found" (S3 answers 204 for a missing key). No prefix check | Strict variant added |
| OneDrive `delete` (`onedrive.ts:182`) | Exists. `id:<itemId>` deletes **any item in the drive** with no base-folder check; otherwise path addressing under the base item | Strict variant uses path addressing only |
| Google Drive `delete` (`gdrive.ts:170`) | Exists, `id:` only. A path is a silent no-op. No check that the id is under the base folder (the full drive scope was chosen on GWP-63, so any file in the drive can be reached) | Strict variant checks the parent chain |
| Unit tests for connector delete | **None** (`apps/runner/test/storage-connectors.test.ts` covers only writes; only the vault write test calls `delete`) | One test group per connector |
| `StorageService.deleteWritten` / `deleteRef` (`service.ts:744`, `:756`) | Exist. They swallow every error and return a boolean | Untouched (write path). `deleteFile` takes the same id/path choice, but strict |
| Runner submission journal + `storage.discard` (GWP-126: `journal.ts`, `service.ts:309`, `:776`) | Exists. The runner remembers what it wrote per submission **for 25 h only** (`JOURNAL_KEEP_MS`). `storage.discard {submissionId}` deletes them all, best effort, with no per-file result. Used by the malware rollback | Not reused for this card (section 3, option C). After a strict delete the runner drops the matching journal entry |
| Server: stored path of each file per submission | **Already recorded**: `form_submissions.parts[].reference` (a `StorageReference` with `connectionId`, `path`, `providerId`) and `answers_refs.{html,json}` | Used as the source of the cleanup queue. No new "what was written" record is needed |
| `pruneFormSubmissions` (`commands/public-forms.ts:425`, called from `Scheduler.triggers`, `scheduler.ts:210`) | Exists. Sets `status='expired'` (also for `storing` rows) and deletes expired rows after 30 days | Extended: it queues the cleanup. A new sweep sends the deletes |
| `StorageRelay` (`storage-relay/hub.ts`) | `write` only. No delete | `delete` added |
| Relay protocol (`packages/shared/src/protocol/runner.ts:2216-2255`) | `storage.write.open/chunk/end/abort/credit/result` only | `storage.delete` and `storage.delete.result` added, plus a capability |
| Cleanup state per file, attempt count, desk status | None | New table, DTO field and UI line |

**Conclusion:** the connector deletes exist but cannot be used as they are. They are best-effort, they do not report
"not found", and two of them (OneDrive by id, Google Drive) are not confined to the base folder. The relay operation,
the cleanup queue, the sweep and the desk status do not exist. The card is not done and goes to build. The server already
keeps every stored path, so the card's "record which files it stored" becomes "copy the recorded references into a
cleanup queue when the submission expires".

## 3. Options compared

**A. Live relay frames `storage.delete` / `storage.delete.result`, driven by a durable server table (recommended).**
`StorageRelay.delete()` sends one frame and waits for the result, with the same pending map, workstation check,
timeout and `onDisconnect` handling as `write`. The queue, the attempt count and the final state live in one server
table that the sweep reads. This is what R1, R2 and R4 ask for. The state the desk sees and the retry policy have one
owner.

**B. A durable runner command (`runner_commands` type `storage.delete`).** This queue already survives offline runners.
But it brings its own generic retry rules (`MAX_COMMAND_ATTEMPTS = 10`, requeue on reconnect, result through
`applyStorageCommandResult`), so a second attempt counter and state would have to be kept in step with the cleanup table.
Its error text is a free string, not a `StorageWriteError`. It also does not give R2's "relay delete".

**C. Reuse `storage.discard {submissionId}`.** No new protocol. But it depends on the runner's journal, which is kept for
25 h only and lives on one machine. A runner offline for a day would silently delete nothing, and nothing would report
that. It returns a count, not a per-file deleted/not found/error result, so AC 5, 7 and 8 cannot be shown. It does no
path confinement.

**Older runners (applies to A and B):** an older runner **drops** an unknown frame type (`client.ts:218`, schema
mismatch → `dropping invalid server frame`), and also a `command` frame whose name is not in its
`RunnerCommandNameSchema` enum. It sends no answer either way, so the server would wait until its timeout. The fix is a capability:
the runner announces `storage-delete:1` in `hello.capabilities` (pattern of `STORAGE_CAPABILITY`,
`SHIFT_LIMIT_CAPABILITY`). The server sends `storage.delete` only to runners that announced it. The others get a typed
`unavailable` answer at once, and the file stays pending. The relay timeout is the second safety net.

**Recommendation: A**, with the capability gate.

## 4. Design

### 4.1 Shared (`packages/shared`)

`src/storage/index.ts`:

```ts
/** Announced in `hello.capabilities` by a runner that handles `storage.delete`. */
export const STORAGE_DELETE_CAPABILITY = 'storage-delete:1';
export const STORAGE_DELETE_TIMEOUT_MS = 30_000;
export type StorageDeleteOutcome = 'deleted' | 'not_found';

/**
 * The segments of a stored path below its destination base, or null when the path could not have come from a write:
 * absolute, a drive letter, a backslash, NUL, empty, '.', '..', or a segment that sanitizeStorageSegment would change.
 * `base` is the S3 prefix or the vault folder: the path must start with `${base}/`, and the base is stripped first.
 */
export function storedPathSegments(path: string, base = ''): string[] | null
```

The check that each segment equals `sanitizeStorageSegment(seg)` holds for every path a write produces, because
`renderStoragePath` sanitises each segment and `storageClashName` keeps the `-2` form. It refuses `..` (sanitised to
`_`), `C:` (sanitised to `C-`), control characters and reserved names. Also refuse a relative path longer than
`MAX_PATH` (400). Unit tests: in `packages/shared/test` (the storage test file next to `renderStoragePath`'s tests).

`src/protocol/runner.ts`:

```ts
export const StorageDeleteSchema = msg('storage.delete', {
  requestId: z.uuid(),
  connectionId: z.uuid(),
  path: z.string().min(1).max(1024),
  providerId: z.string().max(300).optional(),
  submissionId: z.uuid().optional(),   // logging and the runner journal only
});
export const StorageDeleteResultSchema = msg('storage.delete.result', {
  requestId: z.uuid(),
  ok: z.boolean(),
  result: z.enum(['deleted', 'not_found']).optional(),
  error: StorageWriteErrorSchema.optional(),
});
```

Add `StorageDeleteSchema` to `ServerToRunnerSchema` and `StorageDeleteResultSchema` to `RunnerToServerSchema`. Neither is
acked (like `storage.write.*`): the relay timeout and the table retry cover a lost frame.

`src/forms/public.ts`, `FormSubmissionDto` (additive, optional, so an older web build still parses it):

```ts
export type SubmissionCleanupState = 'pending' | 'removed' | 'failed';
stored: Array<{
  label: string;
  path: string;
  /** Set on files of an expired submission once their removal is queued. */
  cleanup?: { state: SubmissionCleanupState; attempts: number; error: string | null };
}>;
/** Counts over `stored[].cleanup`; null when nothing was queued. */
cleanup: { pending: number; removed: number; failed: number } | null;
```

### 4.2 Runner protocol handling (`apps/runner`)

- `runner.ts:1916` message switch: add `case 'storage.delete': this.storage.onMessage(msg)`.
- `runner.ts:1485` hello capabilities: add `STORAGE_DELETE_CAPABILITY`.
- `version.ts`: bump `RUNNER_VERSION` (a protocol addition).

`StorageService.onMessage` → `case 'storage.delete': void this.deleteStored(msg)`:

```ts
private async deleteStored(m: ServerToRunnerOf<'storage.delete'>): Promise<void> {
  const start = this.now();
  const answer = (r: { result: StorageDeleteOutcome } | { error: StorageWriteError }) => {
    this.deps.send('storage.delete.result', { requestId: m.requestId, ok: 'result' in r, ...r });
    this.log(`storage.delete conn=${m.connectionId} kind=${conn?.kind ?? '-'} submission=${m.submissionId ?? '-'} `
      + `path#=${shortHash(m.path)} ${'result' in r ? r.result : r.error.code} ${this.now() - start}ms`);
  };
  const conn = this.store.get(m.connectionId);
  if (!conn) return answer({ error: storageError('not_found', 'This storage is not set up on this workstation.') });
  if (conn.needsReauth) return answer({ error: storageError('auth_expired', 'The sign-in expired: reconnect this storage.') });
  try {
    const r = await this.connector(m.connectionId, conn).deleteFile(
      { path: m.path, ...(m.providerId ? { providerId: m.providerId } : {}) },
      abortAfter(STORAGE_DELETE_TIMEOUT_MS - 2_000, new AbortController().signal),
    );
    if (m.submissionId) this.dropJournalEntry(m.submissionId, m.connectionId, m.path);
    answer({ result: r });
  } catch (err) { answer({ error: this.typed(err) }); }
}
```

Traps:
- **"No such file" must be `result: 'not_found'`, never `error.code: 'not_found'`.** The error code `not_found` also
  means "this storage is not set up on this workstation" or "the vault is not here". The server treats only
  `result: 'not_found'` as success. Mixing the two would mark files removed while they are still there.
- No extra lock. `deleteFile` takes its token through `tokenFn`, which already runs under the per-connection
  `KeyedMutex`, like writes. GWP-127's remove/refresh race tests stay valid. A `storage.remove` during a delete makes the
  token call throw `not_found` (an error), so the file stays pending. Planning asked whether delete needs the GWP-127
  lock: it gets the same treatment as `write`, no new lock.
- `deleteWritten`, `deleteRef`, `rollbackSubmission`, `probe` and connector `delete` are not changed.

### 4.3 Connectors: a strict `deleteFile`

Add this to `StorageConnector` (`types.ts`):

```ts
/**
 * Deletes one file a `put` returned, confined to the destination's base. Never a folder. 'not_found' when the file is
 * not there. Throws StorageError('invalid') for a path outside the base, and a typed error for anything else.
 */
deleteFile(ref: { path: string; providerId?: string }, signal: AbortSignal): Promise<'deleted' | 'not_found'>;
```

Every implementation calls `storedPathSegments` first. On `null` it throws
`StorageError('invalid', 'The file is outside the storage destination.')` **before any I/O or HTTP call**.

| Connector | Stored path is relative to | `deleteFile` |
|---|---|---|
| Local | `root` | `statSync(root)` must be a directory, else `unavailable` (a share that is not mounted must not look like "not found"). `confineUnder(root, segs)` (also refuses symlinks on the way). `lstat`: ENOENT → `not_found`. Not a regular file → `invalid` (never a folder or link). Else `rm` without `force`, ENOENT during rm → `not_found` |
| Vault | vault root, starting with the destination `folder` | `storedPathSegments(path, folder)`. In `withDir`: missing → `not_found`. Else delete through a new exported `removeVaultBinary(dir, path, message, { commit })` in `vaults/write.ts`. It runs `checkedBinaryTarget` (safe path, no symlinks), `rm`, then `git add -- path` and a commit (`Remove <name>`) when the vault is not local, the same rule as `put`. Then `push` best effort |
| S3 | bucket root, key starts with `prefix` | `storedPathSegments(path, prefix)`. `HEAD` key: 404 → `not_found`. 200 → `DELETE`: 2xx → `deleted`, 404 → `not_found`. Other statuses → `fail()` (typed) |
| OneDrive | base folder (`items/{base}:/…`) | **Path addressing only**, ignore `providerId`: an item id can point anywhere in the drive. `DELETE …/items/{base}:/{segs encoded}`. 204 → `deleted`, 404 → `not_found`, else `httpError` |
| Google Drive | base folder; Drive has no paths, so `providerId` is required | No `providerId` → `invalid`. `GET files/{id}?fields=id,name,parents,trashed,mimeType`: 404 or `trashed` → `not_found`. A folder mimeType → `invalid`. `name` must equal the last segment. Then walk `parents[0]` upwards once per folder segment, checking each name, and the next parent must be `baseFolderId` exactly. Otherwise `invalid` (outside the destination). Then `DELETE files/{id}`: 204 → `deleted`, 404 → `not_found` |

Google Drive note: a file whose base folder was trashed and recreated (`gdrive.ts` recreates it and stores the new id)
no longer chains to the current `baseFolderId`. The answer is `invalid`, which the server shows at once as "could not
be removed". This is correct: the file is already in the bin with its old folder.

### 4.4 Server relay (`apps/server/src/storage-relay/hub.ts`)

```ts
export interface StorageDeleteRequest {
  orgId: string; connectionId: string; path: string; providerId?: string; submissionId?: string;
}
export type StorageDeleteResult =
  | { ok: true; result: 'deleted' | 'not_found' }
  | { ok: false; error: StorageWriteError; /** not an attempt: offline or a runner without the capability */ notTried?: true };

async delete(req: StorageDeleteRequest): Promise<StorageDeleteResult>
onDeleteResult(workstationId: string, requestId: string, r: { ok: boolean; result?: …; error?: … }): void
```

- `StorageRelayDeps` gains `supportsDelete(workstationId): Promise<boolean>`. It reads `workstation_capabilities` like
  `supportsStorage` in `commands/storage-connections.ts:48`. Wire it in `app.ts:568`. Its `config` gains
  `deleteTimeoutMs` (default `STORAGE_DELETE_TIMEOUT_MS`) and a separate `maxDeletesInFlight` (8), so cleanup never
  takes the upload slots (`maxInFlight`).
- Order: `lookup` (missing → `not_found`, "The storage connection does not exist."). Then `isOnline` (offline →
  `runner_offline`, `notTried`). Then `supportsDelete` (no → `unavailable`, "The runner on this workstation is too old to
  remove files: update it.", `notTried`). Then the in-flight cap (→ `unavailable`, `notTried`). Then `send('storage.delete',
  …)` (false → `runner_offline`, `notTried`). Then wait for the result, `onGone` or the timeout.
- Keep a separate `pendingDeletes` map (`requestId → { workstationId, settle }`) so `inFlight` (uploads) keeps its
  meaning. `onDisconnect` settles both maps: deletes end as `unavailable`, "The workstation disconnected during the
  delete." (retryable, counted). The timeout ends as `timeout`. A result from another workstation is ignored, as in
  `onResult`.
- Validate the answer. `ok && result ∈ {deleted, not_found}` is success. Anything else becomes the given error, or
  `unavailable` when it is missing.
- Do not call `onOutcome`: health stays driven by writes and runner reports (an `auth_expired` delete already makes the
  runner report `needs_reauth`).
- Log one line per delete through a new `deps.logDelete` (or `log` with an `op` field). Log `{ storage: { op: 'delete',
  connectionId, kind, submissionId, pathHash, outcome, latencyMs } }`.

Gateway: `runner-gateway/handlers.ts:479` adds `case 'storage.delete.result': this.ctx.services.storage.onDeleteResult(
conn.workstationId, msg.requestId, msg); return;`. The `storageAnswer` fast path in `gateway.ts:188` can stay on
`storage.write.*`: deletes are not latency-critical.

**Logging decision (differs from the card wording on purpose).** The card says to log the path. But a rendered path can
contain the client's original file name and reference (`{original}`, `{client}`), and the public form code's rule is
"nothing a client sends reaches a log line" (`public-forms/routes.ts:124`). Both logs carry `submissionId`,
`connectionId`, the outcome and `pathHash` (the first 12 hex characters of the path's SHA-256) instead. The full path is in the
cleanup table and on the desk, so a log line can still be matched to a file.

### 4.5 Data model (new migration `apps/server/migrations/2870_form_submission_cleanup.sql`)

```sql
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS cleanup_queued_at timestamptz;

-- Files of an expired submission that the server removes from the firm's storage. References only, like form_submissions.
CREATE TABLE IF NOT EXISTS form_submission_cleanup (
  submission_id    uuid NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
  seq              smallint NOT NULL,           -- the part index
  org_id           uuid NOT NULL,
  connection_id    uuid NOT NULL,
  label            text NOT NULL,               -- the field id, as listSubmissions labels it
  path             text NOT NULL,
  provider_id      text,
  state            text NOT NULL CHECK (state IN ('pending','removed','failed')),
  attempts         integer NOT NULL DEFAULT 0,
  last_error_code  text,
  last_error       text,                        -- StorageWriteError.message: one sentence, no secret, no path
  queued_at        timestamptz NOT NULL,
  next_attempt_at  timestamptz NOT NULL,
  settled_at       timestamptz,
  PRIMARY KEY (submission_id, seq)
);
CREATE INDEX IF NOT EXISTS form_submission_cleanup_due ON form_submission_cleanup (next_attempt_at) WHERE state = 'pending';
```

The table is operational, like `form_submissions` (not event-sourced, not rebuilt). It needs no data migration: existing
expired rows get queued by the sweep if they qualify (see the rule below; rows that expired long ago are included). That
is the wanted effect.

### 4.6 Cleanup: queue and sweep (`apps/server/src/commands/public-forms.ts`, new `public-forms/cleanup.ts`)

**Queue (in `pruneFormSubmissions`, after the existing expire UPDATE, in one transaction):**

```sql
SELECT id, org_id, parts FROM form_submissions
 WHERE status = 'expired' AND cleanup_queued_at IS NULL
   AND completed_at IS NULL AND answers_refs = '{}'::jsonb      -- R6: no answers document at all
   AND expires_at < $now - $grace
 ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED
```

For each row, insert one `pending` cleanup row per part that has a `reference` (with `next_attempt_at = now`), and set
`cleanup_queued_at = now` (also when no part was stored, so the row is not looked at again).

- **Grace = 2 × `storage.writeTimeoutMs` + 60 s** (3 min with the default 60 s). A part upload or a complete that
  started before `expires_at` can still be writing after it. `PUT …/parts` records its reference with an UPDATE that has
  no status guard (`routes.ts:895`), and `complete` writes two documents. With the grace, every write that started
  before expiry has recorded its reference (or its answers ref) before the queue is built. Nothing is missed and a
  half-completed submission is never queued.
- **"Answers file written" means any answers ref (html or json).** Complete writes html, then json, then sets
  `complete`. A row with only `html` is a failed complete. It is left alone, as today, because the card says never to
  touch a submission that has an answers file. This is the conservative reading. Widening it later is one SQL condition.
- The 30-day DELETE of expired rows keeps working. It skips rows that still have a `pending` cleanup row:
  `AND NOT EXISTS (SELECT 1 FROM form_submission_cleanup c WHERE c.submission_id = form_submissions.id AND c.state='pending')`.

**Sweep `sweepFormUploadCleanup(ctx)`:**

```sql
UPDATE form_submission_cleanup c SET next_attempt_at = $now + interval '5 minutes'      -- lease
 WHERE (c.submission_id, c.seq) IN (
   SELECT c2.submission_id, c2.seq FROM form_submission_cleanup c2
     JOIN form_submissions s ON s.id = c2.submission_id
    WHERE c2.state = 'pending' AND c2.next_attempt_at <= $now
      AND s.status = 'expired' AND s.completed_at IS NULL AND s.answers_refs = '{}'::jsonb  -- R6 re-checked
    ORDER BY c2.next_attempt_at LIMIT 25 FOR UPDATE OF c2 SKIP LOCKED)
RETURNING *
```

For each claimed row, call `ctx.services.storage.delete({ orgId, connectionId, path, providerId, submissionId })`.
Run them with `Promise.allSettled`, at most 8 at once, so one pass takes at most about one delete timeout. Then:

| Result | Row update |
|---|---|
| `ok: true` (`deleted` or `not_found`) | `state='removed'`, `settled_at=now`, `last_error=NULL` |
| `notTried` (runner offline, runner without the capability, busy) | attempts unchanged. `last_error_code/last_error` = the reason (the desk sees why it is pending). `next_attempt_at = now + 5 min` |
| error `invalid` (outside the destination, malformed) | `state='failed'` at once: retrying cannot change it |
| any other error (incl. `not_found` = connection missing, `auth_expired`, `permission`, `timeout`, disconnect) | `attempts+1`, record the error. `attempts >= MAX_CLEANUP_ATTEMPTS` (8) → `state='failed'`, `settled_at=now`. Else `next_attempt_at = now + min(5 min × 2^(attempts-1), 6 h)` (5 min … 6 h, about 18 h in total, enough time for the firm to reconnect a storage whose sign-in expired) |
| connection no longer active (`lookup` → missing) | `state='failed'`, "The storage connection was removed." |

Bound for "never tried": a row that stays `notTried` for 30 days after `queued_at` becomes `failed` ("The workstation
was offline for 30 days."). Without this, a workstation that never returns would keep the submission row forever.

**Scheduler hook:** `Scheduler.triggers` (`scheduler.ts:209`) runs on every tick **and** 750 ms after any event, in one
serial chain. A blocking sweep of 30 s would delay journeys and deliveries. So call
`pruneFormSubmissions(ctx)` there as today (cheap SQL, now also queues), then `kickFormUploadCleanup(ctx)`. That is a
module-level single-flight wrapper: if a sweep is running or the last one started less than 60 s ago, it returns at once.
Otherwise it starts `sweepFormUploadCleanup` without awaiting it, and logs errors as `form upload cleanup failed`.
Tests call `sweepFormUploadCleanup` directly and await it. Two server instances are safe: the lease and `SKIP LOCKED`
stop a double send, and a repeat delete answers `not_found`, which counts as done.

**Desk list (`listSubmissions`):** after loading the page, run one query
`SELECT * FROM form_submission_cleanup WHERE submission_id = ANY($1)`. Attach `cleanup` to the `stored` entry with
the same `path` and label, and fill the per-submission counts. Entries stay listed after removal (with state `removed`),
so the desk sees what was deleted.

### 4.7 Web (`apps/web/src/components/forms/SubmissionsList.tsx`)

No new screen and no new action, only text on the existing row:

- Under the row of an expired submission with `cleanup`, add one summary line: "Uploaded files: 2 removed",
  "1 waiting to be removed", "1 could not be removed". Join the parts with " · ".
- On each `stored` line with `cleanup`, add a suffix: "— removed", "— waiting to be removed (<last_error>)" when a
  reason is set, "— could not be removed: <last_error>".
- Show the reason as visible text, never only in a `title`/tooltip: touch devices have no hover (standing order "design:
  all devices, including touch"). Long text wraps (`break-all` is already on the line). Use `data-testid`s
  `submission-cleanup` and `stored-cleanup-<state>`.
- `useFormSubmissions` needs no change (same endpoint, additive fields).

## 5. Acceptance criteria → design

| AC | Covered by | Test |
|---|---|---|
| 1. Note on what existed | Section 2 of this report, and the handoff summary on the card | — |
| 2. Relay `storage.delete`: deleted / not found = success | 4.1 frames, 4.2 runner handler, 4.4 `StorageRelay.delete` | server `storage-relay.test.ts` (new `describe('delete')`): resolves `deleted` and `not_found`; a typed error is `ok:false`. runner `storage-service.test.ts`: a frame reaches the connector, the result frame has `result` |
| 3. Every connector deletes one file, one unit test each | 4.3 `deleteFile` for local, vault, S3, OneDrive, Google Drive | runner `storage-connectors.test.ts`, one `describe` per connector with mocked fetch / temp dir: existing → `deleted`, missing → `not_found`, HTTP/auth failure → typed error |
| 4. Outside base refused, nothing deleted | `storedPathSegments` + per-connector checks (Google Drive parent chain, OneDrive path only, local `confineUnder` + regular-file check, vault folder prefix + `checkedBinaryTarget`) | shared: `storedPathSegments` cases (`..`, `/abs`, `C:\x`, `C:/x`, backslash, empty segment, prefix mismatch). runner: per connector `../x`, absolute, other drive → `invalid` and **fetch / rm not called** (assert on the mock and that the file outside still exists). Google Drive: an id whose parent chain misses the base → `invalid`, no DELETE sent |
| 5. Two files, no answers, expired → both deleted next sweep, list shows removed | 4.6 queue + sweep, 4.6 desk list | server cleanup test: fake relay; expired row with 2 stored parts, `answers_refs={}` and `expires_at` past the grace → prune + sweep → 2 deletes, both rows `removed`, `listSubmissions` shows `cleanup.state='removed'` and `{removed:2}` |
| 6. Completed submission never deleted | Queue SQL and sweep SQL both require `completed_at IS NULL AND answers_refs='{}'` | server cleanup test: a complete row past expiry, a row with only `answers_refs.html`, and a row inside the grace window → no cleanup row, no delete call |
| 7. Runner offline / disconnect → stays queued, later deleted, repeat = not found = done | `notTried` (offline), counted retry (disconnect, timeout), lease + `SKIP LOCKED`, `not_found` = removed | relay test: disconnect during a delete → `unavailable`. cleanup test: offline → still `pending`, attempts 0; next sweep online → `removed`; a repeat answering `not_found` → `removed` |
| 8. After max attempts → "could not be removed" + last error, no more retries | `MAX_CLEANUP_ATTEMPTS`, `failed` state, `last_error`; sweep selects `pending` only | cleanup test: 8 failing sweeps (clock advanced past `next_attempt_at`) → `failed` with the last message, a 9th sweep makes no call. web test: the row shows "could not be removed: <message>" |
| 9. Older runner → typed error, no crash/hang, stays pending | `STORAGE_DELETE_CAPABILITY` gate in the relay → `unavailable` + `notTried`; relay timeout as the second safety net; the runner's own `handle()` default already answers unknown `storage.*` commands with a typed error | relay test: `supportsDelete=false` → `ok:false`, `notTried`, nothing sent. Relay test: a silent runner → `timeout` within `deleteTimeoutMs`. cleanup test: the row stays `pending`, attempts 0, `last_error` says to update the runner |
| 10. Write path unchanged, existing tests pass | `delete`, `deleteWritten`, `deleteRef`, `rollbackSubmission`, `open/chunk/end` untouched. Relay `write` and `inFlight` untouched (separate map and cap) | run the existing runner `storage-*.test.ts`, server `storage-relay.test.ts`, `public-forms-submit.test.ts`, `public-forms-malware.test.ts`, `public-forms-rebuild.test.ts` unchanged |

## 6. Files to change

- `packages/shared/src/storage/index.ts`: capability, timeout, `StorageDeleteOutcome`, `storedPathSegments` (+ test).
- `packages/shared/src/protocol/runner.ts`: two frame schemas, added to both unions.
- `packages/shared/src/forms/public.ts`: `FormSubmissionDto` cleanup fields.
- `apps/runner/src/storage/types.ts`: `deleteFile` on the interface.
- `apps/runner/src/storage/{local,vault,s3,onedrive,gdrive}.ts`: `deleteFile`.
- `apps/runner/src/vaults/write.ts`: exported `removeVaultBinary`.
- `apps/runner/src/storage/service.ts`: `onMessage` case + `deleteStored` (keep it a small separate block: GWP-142 also
  touches this file).
- `apps/runner/src/runner.ts`: route the frame, announce the capability. `apps/runner/src/version.ts`: bump.
- `apps/server/migrations/2870_form_submission_cleanup.sql`.
- `apps/server/src/storage-relay/hub.ts`: `delete`, `onDeleteResult`, `onDisconnect` for deletes, new deps/config.
- `apps/server/src/app.ts`: `supportsDelete`, `deleteTimeoutMs`, `maxDeletesInFlight`, delete log.
- `apps/server/src/runner-gateway/handlers.ts`: `storage.delete.result` case.
- `apps/server/src/commands/public-forms.ts`: queue in `pruneFormSubmissions`, cleanup in `listSubmissions`, 30-day
  delete guard.
- `apps/server/src/public-forms/cleanup.ts` (new): `sweepFormUploadCleanup`, `kickFormUploadCleanup`, constants.
- `apps/server/src/scheduler/scheduler.ts`: call `kickFormUploadCleanup` after `pruneFormSubmissions`.
- `apps/web/src/components/forms/SubmissionsList.tsx` (+ its test).
- Server test doubles that build a `StorageRelay`/`services.storage` (search the tests for `services.storage`) need the
  new method or deps.

## 7. Risks

- **Deleting a file the client was told is safe.** Mitigated by the double R6 check (at queue time and at send time),
  the grace window and the "any answers ref" rule. Related, existing and out of scope: when the sweep expires a
  `storing` row while `complete` is still running, the final `UPDATE … WHERE status='storing'` updates nothing and the
  handler still answers `done()` (`routes.ts:1071`, `:1110`). With the answers refs written, this card leaves the
  row alone, so no file is deleted. But the desk shows "Timed out" for a submission the client saw as received.
  Suggested as a separate backlog item.
- **A file that is gone vs a destination that cannot be reached:** handled per connector (local root check; the `not_found`
  error code is kept apart from the `not_found` result).
- **Merge overlap:** GWP-142 (PDF copy) and GWP-147 also edit `service.ts`, `hub.ts` and the protocol unions. Keep each
  addition in its own block. A conflict there should only need both sides kept.
- **Google Drive:** checking the parent chain costs one GET per folder segment (usually 1 to 3). That is acceptable for a
  rare cleanup.
- **Vault:** deleting commits to the firm's vault. Same rule as `put` (commit unless the vault is local), so history
  keeps the file, as it does for any vault file. The card does not ask for a purge from history.
- **Server tests need Postgres** (repo `CLAUDE.md`). The cleanup and list tests are DB-backed. The relay, runner, shared
  and web tests are plain unit tests.

## 8. Not in scope

No desk or API action that deletes anything. No deletion of folders. No new OAuth scopes. No change to how or when a
submission expires.
