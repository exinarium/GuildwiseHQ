# GWP-147: direct browser-to-storage uploads for cloud connectors

Status: design. Base: `release/1.6.0` at 285412ed (the card branch starts there). Builds on GWP-63 (connectors), GWP-65
(public forms, security review `docs/security/public-forms.md`), GWP-68 (runner offline flow) and GWP-126 (runner
malware scan, merged).

## 1. The question

Today a public form file goes browser → Guildwise server → runner (storage write relay over the WebSocket) → the firm's
storage. For OneDrive/SharePoint, Google Drive and S3-compatible storage, the runner could hand the browser a short-lived,
single-use upload grant instead, so the file goes straight to the firm's storage and never crosses the Guildwise server.
The card asks: what exists already on release/1.6.0 (step 0), which GWP-65 checks must stay and where they run (the gate),
and how to build it without weakening the public form security or breaking local/NAS, vault and the offline flow.

## 2. Step 0: what release/1.6.0 already has

Checked by reading the code at 285412ed (`grep -rniE "presign|uploadGrant|createUploadSession|uploadType=resumable|X-Amz-Expires"`
over `apps/` and `packages/`, then reading each hit).

| Area | What exists | Is it a grant for the browser? |
|---|---|---|
| `apps/runner/src/storage/onedrive.ts` `put()` / `upload()` | The runner creates a Graph upload session (`createUploadSession`, conflictBehavior `fail`) and pushes the spooled file to it in 5 MiB fragments itself | No. The `uploadUrl` never leaves the runner |
| `apps/runner/src/storage/gdrive.ts` `create()` | The runner starts a Drive resumable session (`uploadType=resumable`) and PUTs the whole spooled file in one request | No. The session URI never leaves the runner |
| `apps/runner/src/storage/s3.ts`, `s3-sign.ts` | SigV4 **header** signing (`signV4`) for PUT/HEAD/DELETE. No query-string (presigned) signing, no GET/LIST, no CopyObject | No |
| `apps/server/src/public-forms/routes.ts` | Start → `PUT …/parts/:index` (raw stream, magic bytes on the first 4100 bytes, relay) → complete. CSP `connect-src 'self'` | No grant endpoint |
| `apps/web/src/public-form/` | `publicApi.putPart` sends the file to the server. `sha256File` already hashes each file in the browser | No direct upload |
| `packages/shared/src/forms/public.ts` | DTOs for start/status/complete only | No grant DTOs |
| Protocol (`packages/shared/src/protocol/runner.ts`) | `storage.write.open/chunk/end/abort/credit/result` only | No grant frames |

**Result: none of GWP-147 is built.** The card is not a duplicate and must not be closed. The connector code above can
be reused (folder creation, clash naming, SigV4 maths, delete), but every grant, verify, staging and browser piece is new.

Hosted (guildwise-cloud, read-only check): `deploy/Caddyfile` and `deploy/nginx-guildwisehq.conf` set no
`Content-Security-Policy` of their own. The public page CSP comes only from `publicPageCsp` in core. All new routes live
under `/api/public/forms/`, which both edges already pass through (JSON, 4 MiB; nginx default 60 s read timeout). The design
keeps every new call short (section 5.5), so **no guildwise-cloud card is needed**. The hosted test
`public-forms-hosted-no-content.test.ts` should keep passing. A tester can add a direct-upload case there later.

## 3. The gate: the GWP-65 decision on server-side checks

`docs/security/public-forms.md` (T8–T12, T16) lists the checks that exist today, but nothing in the ledger says which of
them may move or be dropped for a direct upload. The proposed decision below is sent to the owner as a blocking question
from this shift. **The builder must not start until the answer is linked on the card.** If the owner picks a different
option, sections 5.3 and 5.8 change. The rest of the design holds either way.

**Proposed decision D0 (every check stays, none is dropped):**

| Check today (security doc row) | Where it runs for a direct upload |
|---|---|
| T8 count, total size, per-file size before a byte is read | Server, unchanged, at start **and** again before a grant is issued (declared size against `min(field limit, AOM_STORAGE_MAX_FILE_BYTES)`) |
| T10 type allow list by extension (`FORM_UPLOAD_TYPES`, field rule, executables refused by extension) | Server at start (unchanged `checkPublicAnswers`). No grant for a refused type, and the page shows the existing validation error |
| T10 magic bytes on the first 4100 bytes, executable by content | **Runner, after the upload**, on the staged object (range read, or the full read when it is downloaded anyway), with the same `checkUploadHead` from `@aom/shared` |
| T9 exact size, and integrity (sha256 the browser declared) | Provider-side where the grant can bind it (S3 signed `content-length` and `x-amz-checksum-sha256`), and always **runner-side** on the staged object: size from metadata, sha256 from the provider checksum when exposed, otherwise a full read on the runner |
| T11 malware scan (GWP-126, when `uploadScan.enabled`) | **Runner, after the upload**: the staged object is read into the runner spool and streamed to clamd, fail closed, quarantine and rollback exactly as today |
| T12 path sanitising, no overwrite | Runner, unchanged: the target is rendered with `renderStoragePath` on the runner. The browser only ever writes a staging name. Promotion uses the existing clash rules |

Unverified bytes never appear in the firm's real folders: the browser writes to a hidden staging folder under the base
folder or prefix, and the runner moves the file to its rendered path only after every check passes. A failed check
deletes the staged object, the part fails, and the submission does not record it.

Relay fallback (requirement 6): allowed. A grant that cannot be issued (old runner, S3 bucket without a CORS rule for the
page, upload origin not known, provider error at grant time) makes that part use the existing relay PUT.

A trade-off the owner must accept (T16): the browser now sees the provider upload host, in the page CSP and in the grant
URL (for example `contoso-my.sharepoint.com` or `files.example-bucket.s3.eu-west-1.amazonaws.com`). Only the host is
exposed, never the folder template, connection id or label. The grant URL itself is a short-lived capability for one staging object.

## 4. Options compared

### 4.1 Where the uploaded file lands first

| | A. Hidden staging object, promoted after checks (**recommended**) | B. Straight to the final rendered path | C. OneDrive `deferCommit` / provider-specific holds |
|---|---|---|---|
| Unverified or infected bytes visible in the firm's folders | never | until the runner's checks finish (seconds to minutes) | OneDrive only; Drive and S3 have no equivalent |
| Clash handling (`-2`, `-3`) | at promotion, same code as `put()` | must be fixed before the upload; a race needs a new grant | mixed |
| Cleanup of abandoned uploads | one sweep of one folder/prefix per connection | anywhere in the tree | per provider |
| Cost | one extra metadata call (Graph/Drive move, S3 server-side copy) | none | high, and still needs A or B for the others |

### 4.2 How the grant reaches the browser

| | A. Just-in-time grant per part through the server, over the WebSocket, nothing persisted (**recommended**) | B. All grants in the start answer | C. Through the DB command queue (`enqueueRunnerCommand`) |
|---|---|---|---|
| Grant URL persisted | never (memory only, `no-store` answer) | never | **yes**: command results are rows. Breaks requirement 2 |
| TTL wasted while earlier files upload | no | yes (one file at a time) | n/a |
| Fits existing code | `storage.write.*` fast path in `gateway.ts` | same | n/a |

### 4.3 How the server learns the upload origins for the CSP

The server stores no endpoint, bucket or tenant (`2810_storage_connections.sql`), and the CSP has to list exact origins
(no wildcards). **Recommended:** the runner reports one origin per connection in a new non-acked frame,
`storage.direct.report`, which the server keeps **in memory only**. The runner sends it on `welcome` and after
connect/test. No report means relay. That is also how an old runner falls back without a capability flag.

## 5. Design

### 5.1 Flow

```
browser            server (public routes)              runner                          provider
  | start (manifest) |  pre-checks T8/T10 (unchanged)     |                                 |
  |<-- parts[i].mode = 'direct' | 'relay'                 |                                 |
  | POST parts/i/grant  ---------> storage.grant.open --->| create staging session/presign->|
  |                    <--------- storage.grant.result <--| (url, headers, expiresAt)       |
  |<-- {url, method, headers, chunkBytes, expiresAt}  (no-store, never logged/stored)       |
  | PUT bytes (chunked/resumable) --------------------------------------------------------->|
  | POST parts/i/grant/complete {size, sha256, providerId?, etag?} -> storage.grant.finish ->| verify staged object
  |<-- 202 {state:'verifying'}                         | size, sha256, head, scan, promote, journal
  | GET submissions/sid (poll) <- part 'stored'|'failed' <- storage.grant.verified (reference|error)
  | POST complete (unchanged: answers documents through the relay)                         |
```

### 5.2 Protocol (`packages/shared/src/protocol/runner.ts`, `packages/shared/src/storage/index.ts`)

New server→runner frames (best effort, not in `SERVER_ACKED_TYPES`):

- `storage.grant.open { grantId: uuid, connectionId, folder, name, vars, ext, contentType (ours, from FORM_UPLOAD_TYPES), size, sha256, accepted: string[] (extensions the field accepts), pageOrigin, ttlMs, submission: {orgId, formId, submissionId}, scan: {field, fileName} }`
  (the same rendering inputs as `storage.write.open`, so the runner renders the final path exactly as today).
- `storage.grant.status { grantId }` asks for the next byte offset (resume).
- `storage.grant.finish { grantId, size, sha256, providerId?, etag? }`
- `storage.grant.cancel { grantId, reason: 'client_gone' | 'expired' | 'fallback' | 'shutdown' }`

New runner→server frames (best effort, **not** in `RUNNER_ACKED_TYPES`, so they never enter the runner outbox; handled on
the fast path in `gateway.ts` `storageAnswer`, which today matches only `"storage.write.`):

- `storage.grant.result { grantId, ok, grant?: { provider: 'onedrive'|'google_drive'|'s3', method: 'PUT', url, headers: Record<string,string>, chunkBytes: number|null, expiresAt }, fallback?: boolean, error? }`
- `storage.grant.offset { grantId, offset: number | null }`
- `storage.grant.verified { grantId, ok, reference?: StorageReference, error? }`
- `storage.direct.report { connections: Array<{ connectionId, uploadOrigin: string | null }> }`

`STORAGE_ERROR_CODES` gains `type_refused` (not retryable) so the runner can say "the content did not pass the type check".
The server maps it to 415 `file_type_refused`, as for the relay. Update `STORAGE_RETRYABLE` and every exhaustive switch.

Schema rules: `url` max 4096 and must parse as `https:`. `headers` is at most 8 entries, names from an allow list
(`content-type`, `if-none-match`, `x-amz-checksum-sha256`, `content-range` is never sent by the runner).
`uploadOrigin` must match `^https://[a-z0-9.-]+(:\d{1,5})?$`.

### 5.3 Runner (`apps/runner/src/storage/`)

`types.ts`: an optional capability, so `LocalConnector` and `VaultConnector` stay as they are (relay only, AC 7):

```ts
export interface DirectGrant { provider: 'onedrive' | 'google_drive' | 's3'; url: string; headers: Record<string, string>;
  chunkBytes: number | null; expiresAt: number; /* runner-only: */ stagingRef: string; cancelUrl?: string }
export interface StagedInfo { size: number; sha256?: string /* provider checksum, hex */; providerId?: string }
export interface DirectCapable {
  uploadOrigin(signal: AbortSignal, pageOrigin: string): Promise<string | null>; // null: cannot do direct (e.g. S3 CORS missing)
  grant(stagingName: string, file: { size: number; contentType: string; sha256: string }, ttlMs: number,
        pageOrigin: string, signal: AbortSignal): Promise<DirectGrant>;
  offset(g: DirectGrant, signal: AbortSignal): Promise<number | null>;
  stat(g: DirectGrant, signal: AbortSignal): Promise<StagedInfo | null>;          // null: not there
  read(g: DirectGrant, range: { start: number; end?: number } | null, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  promote(g: DirectGrant, info: StagedInfo, target: StorageTarget, signal: AbortSignal): Promise<{ path: string; providerId?: string }>;
  cancel(g: DirectGrant, signal: AbortSignal): Promise<void>;                     // session cancel + staged delete, best effort
  sweep(keep: (stagingName: string, modifiedAt: number) => boolean, signal: AbortSignal): Promise<number>;
}
export const isDirectCapable = (c: StorageConnector): c is StorageConnector & DirectCapable => 'grant' in c;
```

Staging location: `<base folder or prefix>/.guildwise-incoming/<grantId>.<ext>` (same naming style as `PROBE_NAME`).

| Kind | `grant` | Single use / size / path binding | `stat` hash | `promote` | `uploadOrigin` |
|---|---|---|---|---|---|
| OneDrive (`onedrive.ts`) | `ensureChild(base, '.guildwise-incoming')`, then `createUploadSession` for `<grantId>.<ext>` with `item: { '@microsoft.graph.conflictBehavior': 'fail', fileSize }`. `chunkBytes` 5 MiB (a multiple of 320 KiB). No headers | The session is bound to that item path and ends when the last fragment lands. Graph fixes the total in `Content-Range`. A larger total is caught by `stat` (mismatch → delete) | `file.hashes.sha256Hash` (personal) else none → full read | `PATCH /items/{id}?@microsoft.graph.conflictBehavior=fail` with `{ parentReference: { id: targetFolderId }, name }`, then 409 → next `storageClashName` | origin of a probe upload session's `uploadUrl` created and `DELETE`d during `probe()` (cached per connection) |
| Google Drive (`gdrive.ts`) | `folderPath(['.guildwise-incoming'])`, `POST upload?uploadType=resumable` with `X-Upload-Content-Type`, `X-Upload-Content-Length = size`, **`Origin: pageOrigin`** (Google only answers CORS on the session URI for the origin that started it), metadata `{ name, parents, mimeType }`. `chunkBytes` 8 MiB (a multiple of 256 KiB) | Session bound to the metadata and declared length. Bytes beyond the declared length are refused by Google and caught by `stat` anyway | `files.get?fields=id,size,sha256Checksum,trashed` → `sha256Checksum` | `find()` for clashes, then `PATCH files/{id}?addParents=…&removeParents=…` with `{ name }` | the constant `https://www.googleapis.com` |
| S3 (`s3.ts`, `s3-sign.ts`) | **New `presignV4`** (query auth: `X-Amz-Algorithm/Credential/Date/Expires/SignedHeaders/Security-Token/Signature`, payload `UNSIGNED-PAYLOAD`). Signed headers: `host`, `content-length = size`, `content-type`, `x-amz-checksum-sha256 = base64(sha256)`, `if-none-match: *`. `X-Amz-Expires = ceil(ttlMs/1000)`. `chunkBytes` null (one PUT; the hard max is 100 MiB) | Key and length are in the signature (different path or size → 403). Checksum enforced by providers that support it. `If-None-Match: *` makes a second PUT fail while the staged object exists. It is kept as the used marker until the URL expires (the sweep removes it) | `HEAD` with `x-amz-checksum-mode: ENABLED` → `x-amz-checksum-sha256` else full read | server-side `CopyObject` (`x-amz-copy-source`, with `If-None-Match: *` on the target where supported, after a `HEAD` clash check as in `put()`). The staged object is left for the sweep | `checkS3Endpoint` + https only, then an `OPTIONS` CORS preflight to the bucket from `pageOrigin` for `PUT` with the signed headers. Origin reported only when it passes (cached 10 min) |

`s3.ts` `call()` gains `GET` (range read, `ListObjectsV2` for the sweep) and `OPTIONS`, and the `x-amz-copy-source` header.
http endpoints (MinIO on a LAN) stay relay-only: a public browser cannot reach them, and the CSP must not list `http:`.

`service.ts`: a `grants: Map<grantId, Grant>` next to `transfers`, and handlers for the four new frames, called from
`runner.ts` (`case 'storage.grant.*'` next to the `storage.write.*` cases, about line 1929):

- **open**: connection exists, not `needsReauth`, kind is direct-capable, `uploadOrigin` is known → render the target
  (`renderStoragePath`, refuse on error as `write.open` does) → `ttl = clamp(5 min + size / 128 KiB/s, 5 min, 30 min)`,
  and never past the submission's own expiry (server sends `ttlMs` already clamped) → `connector.grant(...)` →
  `registerSecret(url)` so the runner's log redaction masks it → a timer at `expiresAt` calls `cancel` (Graph and Drive
  sessions live for days at the provider, so the runner enforces the TTL). Reply `storage.grant.result`. Any refusal that
  the relay can handle → `ok:false, fallback:true`.
- **status**: `connector.offset()` → `storage.grant.offset`. Graph returns `nextExpectedRanges`. Drive answers a
  `PUT` with `Content-Range: bytes */size` with 308 + `Range`. S3 returns null, which means restart.
- **finish**: mark the grant used (a second finish → `invalid`), clear the TTL timer, then **verify**:
  1. `stat` → missing → `invalid` "The file did not arrive". Size ≠ declared → delete, `invalid`.
  2. `needFull = scanOn() || !info.sha256`. When `needFull`, stream `read(null)` into the spool
     (`<spoolDir>/<grantId>.part`, mode 0600) while hashing, and keep the first `UPLOAD_HEAD_BYTES`. Otherwise
     `read({start:0,end:UPLOAD_HEAD_BYTES-1})` for the head and use `info.sha256`.
  3. sha256 ≠ declared → delete, `invalid` "The file did not arrive intact".
  4. `checkUploadHead(ext, head, accepted)` refusal → delete, `type_refused`.
  5. Scan (when on): the existing `scanner.scanFile(spool)` and `reject()` path (rollback of the whole submission,
     quarantine from the spool, generic message). Refactor `reject()` so it takes the fields it needs instead of a `Transfer`.
  6. `promote` → `journal.add(...)` (rollback and `storage.discard` keep working) → `StorageReference` with **our**
     content type, size, sha256 → `storage.grant.verified`. Delete the spool file in every outcome.
  7. Any failure after `stat`: `cancel()` (deletes the staged object) before the error goes out.
- **cancel**: `cancel()`, drop the grant.
- **sweep**: on start-up (once per cloud connection, best effort) and every 10 minutes for connections that issued grants.
  It deletes staging entries that belong to no open grant **and** whose grant URL has expired, or whose grant is unknown
  (a restart) and that are older than the 30 min TTL ceiling. This removes abandoned, re-used and orphaned uploads (AC 4, AC 10).
- **close / remove**: cancel all grants of the connection (as `remove()` does for transfers). GWP-127's per-connection
  lock applies to `remove`. Grant work does not take that lock, but it must check that the connection still exists after
  each await (the pattern `end()` uses).
- **report**: `reportDirect()` sends `storage.direct.report` after `reportAll()` (on `welcome`), after connect/test and
  after sign-in. The origin is never written to the health message, a log line, or the outbox.

Logging: one line per grant, `storage.grant conn=… kind=… size=… <outcome> <ms>`. Never the URL, staging id path, file name
or headers (`registerSecret` as a backstop).

### 5.4 Server

`apps/server/src/storage-relay/direct.ts` (new, next to `hub.ts`; the relay itself is not touched):
`DirectUploads` service on `ctx.services`, all in memory:

- `origins: Map<connectionId, { workstationId, origin }>` from `storage.direct.report`, dropped on runner disconnect.
  It validates the origin by kind: Google must be exactly `https://www.googleapis.com`. OneDrive hosts must end in
  `.sharepoint.com` or be `api.onedrive.com` / end in `.microsoftpersonalcontent.com`. S3 accepts any host that matches
  the regex. Anything else is ignored, which means relay.
- `grants: Map<grantId, { sid, index, workstationId, connectionId, expiresAt, state: 'open'|'finishing'|'done' }>` holds
  ids only, never the URL.
- `open(req) → { ok, grant } | { fallback } | { error }` sends `storage.grant.open` and waits up to 20 s for the result,
  then checks `new URL(grant.url).origin === origins.get(connectionId).origin`. If they differ it sends `cancel` and
  returns `fallback`. `finish`, `status` and `cancel` work the same way. `onDisconnect(ws)` fails that workstation's
  open grants (the part goes back to pending).
- Limits: at most 3 grants per part per submission, and `maxInFlight` shared with the relay.

`apps/server/src/public-forms/routes.ts`:

- `publicPageCsp(secure, uploadOrigins: string[] = [])`: `connect-src 'self' <origins…>`, deduplicated and sorted. On
  `GET /f/:publicId` the origins are the reported origins of the file fields' destination connections whose kind is
  onedrive/google_drive/s3, nothing else. `AOM_FORMS_DIRECT_UPLOADS=false` (new setting, default `true`) gives `[]` everywhere.
- `PublicFormDto.uploadOrigins: string[]` (same list) so the page knows which grant origins its CSP allows.
- Start: unchanged checks. `Part` gains `mode: 'direct'|'relay'`, chosen per part from kind + known origin + setting.
  The part states gain `'verifying'`. `SubmissionStartResultDto.parts[].mode`.
- New routes (all `logLevel: 'silent'`, `onRequest`, the upload token, JSON ≤ 8 KiB, `cache-control: no-store`; `op`
  values `grant`, `grant_status`, `grant_complete`, `grant_cancel` in the one metadata log line):
  - `POST …/submissions/:sid/parts/:index/grant`. Checks: row not expired or complete, part pending, `mode === 'direct'`,
    the per-file size check again (T8), field and destination present, `accepted = acceptedUploadExtensions(field.allowedTypes)`,
    our content type from `FORM_UPLOAD_TYPES[part.ext]`, and `ttlMs = min(ttl formula, expires_at - now)`. Then
    `direct.open`. Answers: `200 { mode:'direct', grant:{ method, url, headers, chunkBytes, expiresAt } }`,
    `200 { mode:'relay' }` (fallback, and the part's `mode` becomes relay in the row), `runner_offline` → the existing
    `offline(req, reply, 'part', …)`.
  - `GET …/parts/:index/grant` → `{ offset }` (resume).
  - `POST …/parts/:index/grant/complete { size, sha256, providerId?, etag? }`. `size`/`sha256` must equal the part
    manifest, otherwise 400 and cancel. The part becomes `'verifying'`, `direct.finish` runs without awaiting, and the
    answer is `202 { state: 'verifying' }`. When the verified result arrives: on success the part becomes `stored` with
    the reference after the same `sha256`/`size` comparison as the relay (lines 888–894). `malware_detected` /
    `scan_unavailable` → `rollBackSubmission`. Other errors → `failed` with `error_code`.
  - `POST …/parts/:index/grant/cancel` → cancel, part back to `pending`.
  - The relay `PUT …/parts/:index` refuses (409 `submission_busy`) while a grant for that part is open, so a file is
    never stored twice.
- Status route: parts report `'verifying'`, plus `error` (code) on a failed part. A `'verifying'` part older than
  `relay.writeTimeoutMs` (by `updated_at`) reads as `failed`, which covers a server restart mid-verify.
- Complete route: unchanged (`pending.length` already covers `'verifying'`, so complete waits).
- `app.ts`: the CSP is **not changed**. `contentSecurityPolicy` is applied only when a reply has no CSP, and the public
  page sets its own. Add a regression test that the app CSP is unchanged and the public page CSP wins. The only `app.ts`
  edit is the pino redaction `paths` list (about line 283, next to `*.x-upload-token`): add `*.grant`, `*.url`,
  `*.uploadUrl`.
- Runner offline (GWP-68): start still refuses first (unchanged), and a grant request with the runner gone answers
  through `offline()`. No change in `offline.ts`/`offline-hook.ts` (AC 8).

`apps/server/src/runner-gateway/gateway.ts`: the `storageAnswer` fast path also accepts `"storage.grant.` and
`"storage.direct.` frames. `handlers.ts` gets the same cases for the slow path. Invalid frames log paths only (a grant
frame holds a URL).

### 5.5 Web (`apps/web/src/public-form/`)

- `api.ts`: `grant`, `grantOffset`, `grantComplete`, `grantCancel` (same `call()`), plus `directUpload(grant, file, onProgress, signal)`
  in a new `direct-upload.ts`:
  - `XMLHttpRequest` per request (fetch has no upload progress), `withCredentials = false`, and only the headers the
    grant lists.
  - OneDrive/Drive: chunks of `chunkBytes` with `Content-Range: bytes a-b/size`. A 308 (Drive) or 202 (Graph) means
    "continue". The last chunk answers 200/201, and the provider id comes from its JSON when it is readable.
  - S3: one PUT of the `File`; the ETag comes from the response if it is exposed (it is optional).
  - Interruption (network error, the tab coming back from the background): ask `grantOffset` and continue from the
    offset (slice the `File`). Use at most 5 attempts with back-off. If the offset is null or the grant has expired,
    call `grantCancel`, ask a new grant once, and restart from 0. If that fails, show the existing retryable error.
    Nothing partial is left behind: provider sessions never create an item until complete, S3 PUTs are atomic, and the
    runner sweep removes the rest.
  - If the grant origin is not in `dto.uploadOrigins`, or the first request fails before any byte was accepted (CSP
    block, CORS), call `grantCancel` and use the relay `putPart`.
- `PublicFormPage.tsx`: per part, `mode === 'direct'` → grant → `directUpload` → `grantComplete` → poll `status` every
  2 s until `stored`/`failed`. Relay parts are unchanged. Progress is a percentage per file (`PUBLIC_TEXT` gets
  "Uploading {name}: {n}%" and "Checking {name}…"). Errors use `describePublicError` with the existing codes
  (`file_type_refused`, `invalid_answers` "does not match what was announced", `malware_detected`, `scan_unavailable`).
  It must work on touch devices: no hover-only UI, progress text in the existing live region, and the `File` kept in
  memory for resume (as today for retries).
- `messages.ts`: map `type_refused` → the existing file-type message.

### 5.6 Shared DTOs (`packages/shared/src/forms/public.ts`)

`GrantDto { mode: 'direct'; grant: { method: 'PUT'; url: string; headers: Record<string,string>; chunkBytes: number|null; expiresAt: string } } | { mode: 'relay' }`,
`GrantCompleteSchema = z.object({ size: int ≥1, sha256: Sha256, providerId: string ≤300 optional, etag: string ≤300 optional })`,
`GrantOffsetDto { offset: number | null }`, and part `mode`, `'verifying'` and `error?` in the start/status DTOs, plus `uploadOrigins` in `PublicFormDto`.

### 5.7 TTL (requirement 7, AC 4)

`ttl = clamp(5 min + declaredSize / (128 KiB/s), 5 min, 30 min)`, capped by the submission's remaining life
(`AOM_FORMS_SUBMISSION_TTL_MIN`, 120 min). For 25 MiB that is about 8.3 minutes, and for 100 MiB about 18.3 minutes, which
allows a slow 1 Mbit/s phone link. S3 enforces it in the signature. For Graph and Drive the runner enforces it (a timer
cancels the session, and the sweep deletes the staged entry).

### 5.8 Risks and open points

- **Drive CORS**: browser uploads to a session URI need the `Origin` header on the session start. Undici's `fetch` lets
  the runner set it. This must be confirmed in UAT with the real OAuth app. If it fails, Drive grants report `fallback`
  and the relay is used.
- **Graph upload hosts**: the upload host is tenant-specific. The runner learns it from a probe session. If a later
  session comes back on another host, the server cancels and falls back (section 5.4).
- **S3 providers differ**: `x-amz-checksum-sha256` and `If-None-Match` are honoured by AWS, MinIO and R2, but not by
  every S3 clone. The runner-side verify and the sweep are the guarantee, and the provider checks are extra.
- **Firm bandwidth**: when the scan is on, or the provider exposes no sha256 (OneDrive for Business), the runner reads
  the whole object once. That is the firm's own link. Guildwise still sees no bytes.
- **Single instance**: grants and origins are in memory, the same assumption as the relay (`docs/security` residual risk).
- **Group overlap**: GWP-142 and GWP-143 (same group, queued) change `routes.ts` and `service.ts`. Merge carefully. GWP-143's
  relay delete is separate from the runner-side `cancel` here.

## 6. Acceptance criteria → design

| AC | Design |
|---|---|
| 1. Release/1.6.0 check recorded | Section 2 (also posted on the card). Nothing is built, so the card stays open |
| 2. GWP-65 decision linked; every kept check enforced and tested | Section 3 (D0, owner answer linked on the card); tests in section 7 rows R4–R7 and S1–S2 |
| 3. Uploads to OneDrive, Drive and S3 arrive; no bytes through the server | Sections 5.1–5.5. Only JSON ≤ 8 KiB on the new routes, and the per-call log line shows `sizeBytes`. MinIO byte-counter test for testers |
| 4. One file, one path, TTL, second use, expiry, other path and larger size fail | Section 5.3 table (path and size binding, `If-None-Match`, session end), section 5.7 TTL, runner `finish` single use, server 3-grant cap, verify step 1 |
| 5. Type or size against limits → no grant, existing validation error | Start checks unchanged plus the grant route's size re-check (section 5.4). The page shows the existing errors |
| 6. Size or hash mismatch → deleted, error, not delivered | Runner verify steps 1–3 and 7, server part `failed`, complete refuses with `parts_missing` |
| 7. Local/NAS and vault still relay; their tests unchanged | `isDirectCapable` is false for `LocalConnector`/`VaultConnector`, mode `relay`, relay code untouched |
| 8. Offline secure-link flow works | Start refusal unchanged; a grant with the runner gone → `offline()`; no change to `offline*.ts` |
| 9. CSP lists only the needed upload origins | `publicPageCsp(secure, origins)` from reported, validated origins of the form's destinations; no wildcards; `http:` never |
| 10. 100 MB resumable on OneDrive and Drive; interrupted → resume or clean failure, no orphans | Chunked XHR, offset through the runner, a new grant once, sweep (section 5.3), and provider sessions that never leave partial items |

## 7. Tests (unit only for the builder; integration and UAT for testers)

Runner (`apps/runner/test/`):
- R1 `storage-s3-presign.test.ts`: `presignV4` against the AWS documented presigned-URL vector (examplebucket `test.txt`,
  20130524, 86400 s) and a PUT with signed `content-length`/`content-type`/`x-amz-checksum-sha256`/`if-none-match`;
  `X-Amz-Expires` equals the TTL; a session token is included.
- R2 `storage-direct-onedrive.test.ts`, `storage-direct-gdrive.test.ts`, `storage-direct-s3.test.ts` (mocked fetch):
  grant creates the staging session at `.guildwise-incoming/<id>.<ext>`; Drive start carries `Origin` and
  `X-Upload-Content-Length`; S3 OPTIONS preflight fail → `uploadOrigin` null → grant `fallback`; http S3 endpoint →
  no direct; `offset` parsing; `promote` with clash `-2`; `cancel` deletes session and staged item.
- R3 `storage-service-grant.test.ts`: TTL clamp; timer cancels at expiry; a second `finish` → `invalid`; unknown
  grant → `invalid`; `remove()` cancels grants; the URL is never in a log line (scan the captured log for the URL).
- R4 verify: size mismatch → staged delete + `invalid`; sha mismatch (provider checksum and full-read paths) → delete;
  missing object → `invalid`; the `MZ` head for a `.pdf` → `type_refused` + delete; success → journal entry and
  reference with our content type.
- R5 scan on: infected → `malware_detected`, rollback of the submission's journal, quarantine file written; clamd
  down → `scan_unavailable`; scan off → no full read when the provider exposes sha256 (only a range GET).
- R6 sweep: deletes entries without an open grant past expiry; keeps an open grant's entry; after a "restart" deletes
  only entries older than 30 min.
- R7 `LocalConnector`/`VaultConnector` are not direct-capable; `storage.grant.open` for them → `fallback`; the existing
  `storage-local`, `storage-vault`, `storage-service*` tests pass unchanged.

Server (`apps/server/test/`):
- S1 `public-forms-direct.test.ts` (fake runner, as in `storage-relay.test.ts`): start returns `mode` per part (cloud with
  origin → direct; local/vault → relay; no origin → relay; setting off → relay); a grant for a type or size over the
  limit is never issued (the start 413/415 stays); per-file size re-check at grant; 3-grant cap; grant origin ≠
  reported → cancel + `relay`; runner offline at grant → offline answer; complete with a size/sha different from the
  manifest → 400; verified ok → part `stored`; verified `invalid`/`type_refused` → part `failed` and complete refuses;
  `malware_detected` → submission rolled back; relay PUT refused while a grant is open.
- S2 secrecy: the grant URL is not in any log line (capture pino), not in `form_submissions` (table dump), and not in
  `runner_commands`; the answer has `cache-control: no-store`.
- S3 `public-forms-headers.test.ts`: CSP `connect-src` is exactly `'self'` plus the reported origins of this form's
  destinations; a form with only local destinations keeps `connect-src 'self'`; an invalid or wildcard origin report
  is ignored; app CSP unchanged (`app.ts` regression).
- S4 the existing `public-forms-submit`, `storage-relay`, `public-forms-offline*` and `public-forms-malware` tests pass unchanged.

Web (`apps/web/test/`):
- W1 `public-form-direct.test.tsx` (mocked XHR and API): chunked upload with progress text; resume from the offset
  after a dropped chunk; expiry → new grant once → restart; grant origin not allowed → relay `putPart`; completion
  report carries size and sha256; `verifying` → poll → stored; failed verification shows the "does not match" message;
  `type_refused` shows the file-type message.

Testers (not run by the builder): MinIO end to end with server byte counters and a tampered/oversized PUT;
UAT 100+ MB to real OneDrive and Drive (needs the GWP-63 OAuth apps); the existing e2e `storage.spec.ts` and offline flow.

## 8. Docs the builder updates with the code

- `docs/security/public-forms.md`: T8–T13 and T16 rows (where each check runs for a direct upload, the staging folder,
  the CSP origins, the host exposure), a settings line for `AOM_FORMS_DIRECT_UPLOADS`, and the decision link.
- `docs/investigations/GWP-63-…md` §3.1: option C is now built for the cloud kinds (pointer to this report).
- `docs/investigations/GWP-65-…md` §3.5: how an upload reaches the runner now has two paths.
- `docs/investigations/GWP-68-…md`: one line saying the offline flow is unchanged because start still refuses first.
- `docs/RUNNER.md`: the `.guildwise-incoming` staging folder, the S3 bucket CORS rule a firm adds to enable direct
  uploads (allowed origin = the public origin, method PUT, the four headers), and the sweep.
