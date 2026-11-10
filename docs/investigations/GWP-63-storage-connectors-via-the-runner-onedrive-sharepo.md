# GWP-63 Storage connectors via the runner: OneDrive/SharePoint, Google Drive, S3-compatible, local folder/NAS and vault

Status: design, ready to build. Target branch: `release/1.5.0`. Next card in the group: GWP-65 (public form hosting), which
calls the write operation designed here. GWP-64 (forms builder) reads the connection list; GWP-68 (runner offline) reads
the typed error codes and runner presence; GWP-69 (guildwise-cloud) routes the same relay on the hosted service.

## 1. The question

A firm connects its own storage (OneDrive/SharePoint, Google Drive, S3-compatible, a local folder or NAS, a vault folder).
Form uploads and form answers must land there and never on a Guildwise server. Tokens and keys stay encrypted on the firm's
workstation and only the runner uses them. We need:

1. the connection model (what the server knows, what the workstation knows);
2. how the user signs in on the workstation for each kind;
3. one write operation (folder and name templates, a reference back, typed errors, bounded time);
4. how the server gets the bytes from a public request to the runner without storing them (requirement 7);
5. Test connection, "Needs re-authentication" with reconnect, rename and remove.

## 2. Findings in the code

| Where | What is there | Use for this card |
|---|---|---|
| `apps/runner/src/secrets/sealed-file.ts` | `SealedFile<T>`: AES-256-GCM, key from `RunnerKeys.deriveFileKey(fileName)`, AAD = file name, 0600 in a 0700 `secrets/`, atomic rename, registers secrets for redaction | **Reuse** as the token store (`secrets/storage.json`). No second scheme. |
| `apps/runner/src/outbound-delivery/send.ts` | `whatsappStore`, `sheetsStore` built on `SealedFile` | Same pattern for `storageStore`. |
| `apps/runner/src/forge/tokens.ts` | `git-tokens.json`, **plain JSON** (not sealed) | Do **not** copy: it predates `SealedFile`. |
| `packages/shared/src/integrations/seal.ts`, `schema.ts`; `RunnerKeys.open` in `apps/runner/src/secrets/keys.ts`; `apps/runner/src/integrations/seen.ts` | Browser seals fields to the runner's RSA key (RSA-OAEP-256 + A256GCM), AAD binds workstation, ref, kind, instance, op; runner checks expiry and replay. Owner approved this path on 2026-10-14 (integrations-page.md §11, Q2/Q4). | **Reuse** for the fields a user types for S3 keys, a local path or a vault folder. |
| `ENVELOPE_COMMANDS` in `packages/shared/src/protocol/runner.ts`, `runner_commands.expires_at` | Envelope commands expire after 10 min and the payload is emptied on result. | Add `storage.connect`. |
| `apps/server/src/webhook-relay/hub.ts` (`RelayHub`) | In-memory request/answer over the runner WebSocket, nothing queued or stored, only metadata rows (`relay_requests`). Body cap 4 MiB in one frame. | The **pattern** for the write relay. Not the same class: one frame cannot carry a 25 MiB upload (server `maxPayload` is 8 MiB, `apps/server/src/app.ts:538`). |
| `apps/server/src/runner-gateway/gateway.ts:101-111` | Invalid frames are logged with zod issues, except `relay.*`, which logs paths only | Extend the exception to `storage.*` (a chunk frame holds client content). |
| `apps/runner/src/vaults/write.ts` (`writeVaultBinary`, `refuseSymlinks`, `isSafeVaultPath`) | Binary write into a vault clone with commit; symlink and path checks | The vault connector calls it. |
| `apps/runner/src/integrations/session.ts` (`LoginSession`) | Drives **CLI** logins in a pty | Not a fit: OAuth device flow is plain HTTP. A small `storage/oauth.ts` does it. |
| `apps/web/src/pages/OrgSettings.tsx` + `components/orgsettings/RelayTab.tsx` | Org-level tabs; the relay tab is the closest UI precedent (org metadata + workstation-held secret) | New **Storage** tab. |
| `apps/server/migrations/2751_relay.sql`, `packages/shared/src/events/relay.ts`, `apps/server/src/projections/relay.ts`, `apps/server/src/projections/rebuild.ts` | Event-sourced org metadata + operational presence table (kept over rebuild) | Same split for storage connections. |
| Runner dependencies (`apps/runner/package.json`) | Small set, no AWS or Google SDK; Google Sheets JWT is hand-rolled | Hand-roll SigV4 and the three REST clients with `fetch`; no new dependency. |

Planner questions, answered:
- **S3 keys: browser or workstation only?** Through the browser **sealed to the runner key** (the approved integrations
  path), plus a runner CLI alternative. The server only ever relays ciphertext that is emptied on result. The bucket,
  endpoint and prefix are inside the same envelope, so the server does not learn them either.
- **Vault: own sealing or just a folder?** Just a vault id + folder. It uses the vault's existing clone and access; nothing
  new is stored besides that config entry (kept in `storage.json` like the others, for one code path).
- **Does the relay hub keep the payload?** No: `RelayHub` holds requests in memory only and `relay_requests` holds
  metadata (no body). The storage relay follows the same rule and adds no content table at all.

## 3. Options compared

### 3.1 How the bytes reach the runner (requirement 7)

| | A. Streamed relay over the runner WebSocket, no persistence (**recommended**) | B. Runner pulls from the server over HTTP | C. Browser uploads straight to the firm's storage (runner hands out a presigned / upload-session URL) |
|---|---|---|---|
| Content on Guildwise disk/DB | never (bounded memory window only) | the server must hold the whole file until the pull (memory or disk) | never touches Guildwise |
| Works for all five kinds | yes | yes | no: not for local folder/NAS or vault; S3 needs bucket CORS set by the firm |
| Server can enforce size/type, compute checksum | yes, while streaming | yes | no (the file bypasses the server; the security review of GWP-65 loses its checks) |
| Upload-session URL exposed to a public browser | no | no | yes (a bearer capability valid for hours/days) |
| Runner offline behaviour | immediate `runner_offline` | same | same |
| Cost | medium: chunk + credit frames, one hub class | medium, plus a runner HTTP auth path and a holding store | high, three provider-specific flows plus a fallback for the other two kinds |

**Decision D1: A.** The server reads the public upload as a stream, forwards it in chunks to the one workstation that
holds the connection and never writes it anywhere. Flow control keeps at most `window × chunk` bytes per transfer in
memory. C is recorded as a later optimisation for the cloud kinds (backlog suggestion), not this card.

### 3.2 How the user signs in to OneDrive/SharePoint and Google Drive

| | Device authorization grant (RFC 8628) run by the runner (**recommended**) | Loopback redirect on the runner + paste-back of the redirect URL | Browser does OAuth, server exchanges the code |
|---|---|---|---|
| Token ever on the server | no | no (the code is sealed; PKCE verifier stays on the runner) | **yes**: forbidden by standing order 1800e58c |
| Works for VPS / Codespace workstations | yes | yes, with an awkward paste | yes |
| UX | "Open microsoft.com/devicelogin, enter ABCD-EFGH": same as the GitHub device tile | copy a failing localhost URL | best |
| Google scope | device flow allows only `drive.file` / `drive.appdata` (+ `openid email`) | any | any |

**Decision D2: device flow for both.** Microsoft: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode`,
scopes `offline_access Files.ReadWrite.All Sites.ReadWrite.All User.Read`, public client (no secret), tenant default
`common` (personal OneDrive and work accounts). Google: `https://oauth2.googleapis.com/device/code`, scopes
`https://www.googleapis.com/auth/drive.file openid email`, the "TVs and Limited Input devices" client (its client secret is
non-confidential by Google's own model; it is not committed to the repo, see D9).

`drive.file` consequence (owner confirmation asked, non-blocking): the connector can only see files and folders **it
created**. So a Google Drive connection writes under a base folder the connector creates (name chosen by the user, default
"Guildwise uploads"); the firm can move or share that folder afterwards. The full `drive` scope is a Google *restricted*
scope (yearly third-party security assessment), which is why it is not proposed.

### 3.3 Where templates are rendered

Rendered **on the runner** with a pure function from `packages/shared` (the server runs the same function first to refuse a
bad template fast; the forms builder can preview with it). One conservative sanitiser for every kind (Windows/SMB-safe), so
a template gives the same path on every store.

## 4. Design

### 4.1 Data model: what lives where

**Server (metadata only; requirement 2):**

Migration `apps/server/migrations/2810_storage_connections.sql` (next free number at build time):

```sql
CREATE TABLE IF NOT EXISTS storage_connections (       -- projection of the StorageConnection* events
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL,                                 -- onedrive | google_drive | s3 | local | vault
  label text NOT NULL,
  workstation_id uuid NOT NULL REFERENCES workstations(id),
  status text NOT NULL DEFAULT 'active',              -- active | removed
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  removed_at timestamptz
);
CREATE INDEX IF NOT EXISTS storage_connections_org ON storage_connections(org_id);

CREATE TABLE IF NOT EXISTS storage_connection_health ( -- operational, reported by the runner; kept over rebuild
  connection_id uuid PRIMARY KEY REFERENCES storage_connections(id),
  state text NOT NULL,           -- pending | connected | needs_reauth | unavailable | permission | quota | not_on_workstation
  error_code text,               -- a StorageErrorCode, or NULL
  message text,                  -- one sentence, max 300, never a value, path or token
  checked_at timestamptz NOT NULL,
  last_ok_at timestamptz
);

CREATE TABLE IF NOT EXISTS storage_requests (          -- operational, short-lived (pruned after 24 h)
  id uuid PRIMARY KEY,                                -- browser requestId or server sessionId
  connection_id uuid NOT NULL REFERENCES storage_connections(id),
  workstation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('connect','auth','test','remove')),
  state text NOT NULL,           -- pending | awaiting_user | done | failed | cancelled | expired
  prompt jsonb,                  -- device flow only: { userCode, verificationUri, expiresAt }; never a token
  error_code text, message text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
);
```

`storage_connection_health` is added to the keep-over-rebuild list in `apps/server/src/projections/rebuild.ts`
(`restoreWhere: 'connection_id IN (SELECT id FROM storage_connections)'`). `storage_requests` is not (short-lived; pruned
in the existing job loop like `integration_requests`). No table holds a token, key, endpoint, bucket, path root, file
content or form answer.

Events (`packages/shared/src/events/storage.ts`, stream `storage-<connectionId>`, org scope), registered in the events index:
- `StorageConnectionCreated { connectionId, orgId, kind, label (max 80), workstationId, by }`
- `StorageConnectionRenamed { connectionId, label, by }`
- `StorageConnectionRemoved { connectionId, by }`

Projection `apps/server/src/projections/storage.ts` (registered where `relay.ts` is).

**Workstation (`<data dir>/secrets/storage.json`, `SealedFile`, one per pairing):**

```ts
StorageSecrets = { connections: Record<connectionId, {
  kind: StorageKind; savedAt: string;
  config:                                   // never leaves the workstation
    | { kind:'onedrive'; siteUrl?: string; driveId: string; baseFolder: string; baseItemId?: string }
    | { kind:'google_drive'; baseFolder: string; baseFolderId?: string }
    | { kind:'s3'; endpoint: string; region: string; bucket: string; prefix: string; pathStyle: boolean }
    | { kind:'local'; root: string }
    | { kind:'vault'; vaultId: string; folder: string };
  auth?:
    | { type:'oauth'; accessToken: string; refreshToken: string; expiresAt: number; scope: string; account?: string }
    | { type:'keys'; accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  needsReauth?: boolean;
}> }
```
`secretsOf` returns `accessToken`, `refreshToken`, `secretAccessKey`, `sessionToken` (redaction). `account` (the e-mail
signed in) stays local: shown by `guildwise-runner storage list`, not reported (requirement 2 lists exactly what the
server knows).

### 4.2 Shared (`packages/shared/src/storage/index.ts`, exported from the package index)

```ts
export const STORAGE_KINDS = ['onedrive', 'google_drive', 's3', 'local', 'vault'] as const;   // onedrive covers SharePoint (siteUrl)
export const STORAGE_ERROR_CODES = ['auth_expired','unavailable','quota','permission','not_found',
  'invalid','too_large','conflict','runner_offline','timeout'] as const;
export const STORAGE_RETRYABLE: Record<StorageErrorCode, boolean> =
  { unavailable:true, timeout:true, runner_offline:true, auth_expired:false, quota:false, permission:false,
    not_found:false, invalid:false, too_large:false, conflict:true };
export const STORAGE_CHUNK_BYTES = 256 * 1024;   // raw bytes per chunk frame
export const STORAGE_WINDOW = 8;                 // chunks in flight per transfer (2 MiB)
export const STORAGE_MAX_FILE_BYTES = 25 * 1024 * 1024;       // default; hard ceiling 100 MiB
export const StorageReferenceSchema = z.object({
  v: z.literal(1), connectionId: z.uuid(), kind: StorageKindSchema,
  path: z.string().max(1024),        // root-relative path, or the S3 object key (prefix included)
  providerId: z.string().max(300).optional(),   // Drive file id, Graph driveItem id, S3 VersionId or ETag
  size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.string().max(200), writtenAt: z.iso.datetime() });
export const StorageWriteErrorSchema = z.object({ code: StorageErrorCodeSchema, message: z.string().max(300), retryable: z.boolean() });
export const StorageHealthSchema = …;   // state, errorCode?, message?, checkedAt, lastOkAt?
export const StorageConnectionDtoSchema = …;  // id, kind, label, workstation {id, name, online}, health, createdAt, canConnect
export function renderStoragePath(t: { folder: string; name: string }, vars: Record<string,string>, ext?: string)
  : { ok: true; folder: string[]; name: string } | { ok: false; error: string };
```

Template rules (`renderStoragePath`, unit-tested):
- Placeholders `{key}`, `key` in `[a-z][a-z0-9_]{0,31}`. Known keys: `journey`, `client`, `form`, `field`, `submission`,
  `date` (YYYY-MM-DD), `time` (HHmmss), `original` (original file name without extension), `ext`. The caller supplies the
  values (the server fills `date`/`time` from the submission time in the org's time zone). Unknown key or missing value →
  `invalid`. `{{` / `}}` are literal braces.
- `folder` splits on `/`; each segment and the name are sanitised: control chars and `\ / : * ? " < > |` → `-`, runs of
  `-` and spaces collapsed, leading/trailing dots and spaces trimmed, Windows reserved names (`CON`, `NUL`, `COM1`, …)
  get a `_` suffix, empty → `_`, each segment ≤ 120 chars, whole path ≤ 400. `.` and `..` can never survive.
- If the rendered name has no extension, `.ext` is appended (from `ext`, else from the content type, else none).
- Name clash at the destination: never overwrite; the runner appends `-2`, `-3` … up to `-20`, then `conflict`.

Protocol additions (`packages/shared/src/protocol/runner.ts`, all additive):

Durable commands (`CommandPayloadSchemas`, delivered through `runner_commands`, results by `command.result`):

| command | payload | result |
|---|---|---|
| `storage.connect` (in `ENVELOPE_COMMANDS`) | `{ requestId, connectionId, kind, envelope }` — fields: S3 `endpoint, region, bucket, prefix, pathStyle, accessKeyId, secretAccessKey`; local `root`; vault `vaultId, folder` | `{ health }` or `{ error: StorageWriteError }` |
| `storage.auth.begin` | `{ sessionId, connectionId, kind, options: { siteUrl?, baseFolder? } }` (payload emptied on result, expires 10 min) | `{ prompt: { userCode, verificationUri, expiresAt } }` or `{ error }` |
| `storage.auth.cancel` | `{ sessionId }` | `{}` |
| `storage.test` (expires 2 min) | `{ requestId, connectionId }` | `{ health }` (health holds the typed error on failure) |
| `storage.remove` (no expiry: must reach the workstation even days later) | `{ connectionId }` | `{ removed: boolean }` |
| `storage.sync` (sent after `welcome`) | `{ connectionIds: uuid[] }` — every active connection of this workstation | `{ removed: uuid[] }` |

Messages (not queued; `storage.report` and `storage.auth` are added to `RUNNER_ACKED_TYPES`):
- runner → server `storage.report { connections: [{ connectionId, state, errorCode?, message?, checkedAt }] (max 100) }`:
  after welcome, connect, auth success/failure, test, remove, and when a write or refresh discovers `auth_expired`.
- runner → server `storage.auth { sessionId, connectionId, state: 'awaiting_user'|'done'|'failed'|'expired'|'cancelled', error? }`.
- server → runner `storage.write.open { transferId, connectionId, folder, name, vars, ext?, contentType, size, deadlineMs }`
- server → runner `storage.write.chunk { transferId, seq, data (base64, ≤ STORAGE_CHUNK_BYTES raw) }`
- server → runner `storage.write.end { transferId, chunks, size, sha256 }`
- server → runner `storage.write.abort { transferId, reason: 'timeout'|'client_gone'|'too_large'|'shutdown' }`
- runner → server `storage.write.credit { transferId, upTo }` (the server may send chunks `seq < upTo`; the first credit,
  `upTo = STORAGE_WINDOW`, also means "open accepted")
- runner → server `storage.write.result { transferId, ok: true, reference } | { transferId, ok: false, error }`

Capability `storage:1` in `hello.capabilities` (new constant `STORAGE_CAPABILITY`). Connect/test on an older runner →
409 `runner_too_old` with the "update your runner" message.

Envelope: widen `SealedPlaintextSchema.kind` and `SealInput.kind` (`packages/shared/src/integrations/schema.ts`,
`seal.ts`) and `EnvelopeOuter.kind` (`apps/runner/src/secrets/keys.ts`) to `IntegrationKindId | 'storage'`, with
`instance` = connection id and `op = 'connect'`. The AAD format is unchanged, so the binding (workstation, ref, kind, instance, op) holds.

### 4.3 Runner (`apps/runner/src/storage/`)

| File | Content |
|---|---|
| `store.ts` | `storageStore(secretsDir, keyOf)` on `SealedFile` (`secrets/storage.json`); `get/put/remove/list`; `remove` of the last entry deletes the file; a per-connection async mutex (token refresh rotates the Microsoft refresh token: two writes must not refresh at once). |
| `types.ts` | `StorageConnector { probe(signal): Promise<void>; put(target, file: Spooled, signal): Promise<{ path; providerId? }>; delete(path, signal): Promise<void> }`, `class StorageError(code, message)`, `Spooled { file, size, sha256, contentType }`. |
| `errors.ts` | Pure mapping per kind (below), plus `fromNodeError(err)` for fs. |
| `oauth.ts` | Device flow start + background poll (interval, `slow_down`, `authorization_pending`, expiry 15 min, one live flow per connection, `AbortController`), token refresh with a 60 s early margin, `invalid_grant`/`interaction_required` → `auth_expired` (sets `needsReauth`, sends `storage.report`). Client ids from config (D9). |
| `onedrive.ts` | Graph. Drive: `siteUrl` → `GET /sites/{host}:/{path}` → `/sites/{id}/drive`, else `/me/drive`. Base folder created on connect (`POST …/children`, `@microsoft.graph.conflictBehavior: fail`, reuse if it exists). Upload: `createUploadSession` with `conflictBehavior: fail`, chunks of 5 MiB (a multiple of 320 KiB). Sub-folders created on demand. |
| `gdrive.ts` | Drive v3. Base folder created on connect (`mimeType application/vnd.google-apps.folder`), id saved; recreated if it is gone or trashed. Sub-folders by `files.list q="name='…' and '<parent>' in parents and trashed=false"`. Upload: resumable session (`uploadType=resumable`) then one PUT of the spooled file. |
| `s3.ts`, `s3-sign.ts` | SigV4 (hand-written with `node:crypto`; tested against the AWS signature test vectors). `PutObject` with `x-amz-content-sha256` = the real sha256 (the store also verifies integrity), `HeadObject` for clashes, `DeleteObject`. Virtual-host or path style. `http://` allowed only for a loopback or private address (MinIO on the LAN), else https. |
| `local.ts` | Root must be absolute, an existing directory, not `/`, not inside the runner data dir. Target resolved and confined under the root; `refuseSymlinks`-style walk; write to `<target>.part-<transferId>` then `rename` (a reader never sees half a file); clash check before rename. Windows: UNC roots (`\\server\share\…`) accepted. |
| `vault.ts` | Resolves the vault dir through `vaults/manager.ts`; `writeVaultBinary(dir, { path, commitMessage: 'Add <name>' }, bytes, { commit: !localFolder })`; push through the existing sync (a push failure does not fail the write: the file is committed and syncs later). `vault` + `folder` must pass `isSafeVaultPath`. |
| `service.ts` | `StorageService`: handles the commands above, the transfers and the reports. |
| `cli.ts` (or a `storage` subcommand in `apps/runner/src/cli.ts`) | `guildwise-runner storage list` (id, kind, label from config, account, state; no secret), `storage test <id>`, `storage remove <id>`. Optional: `storage connect <id>` (S3 keys / path prompted on the terminal, OAuth device code printed) for users who keep web-submitted credentials off. |

Write path in `StorageService` (one transfer):
1. `open`: connection unknown → result `not_found`; `needsReauth` → `auth_expired`; refresh the token if it is due (failure
   → `auth_expired`); size > limit → `too_large`; template invalid → `invalid`. Otherwise answer `credit { upTo: 8 }`.
   All of this answers within 10 s.
2. `chunk`: in order only (gap → abort with `invalid`), appended to `<data dir>/tmp/storage/<transferId>.part` (0600) while
   hashing; credit again every 4 chunks. The spool is the firm's own disk, not Guildwise's.
3. `end`: size and sha256 must match the server's (else `invalid`); `connector.put` with `AbortSignal` = remaining deadline;
   result `ok` with the reference, or the typed error. The spool is deleted in `finally`; the spool dir is emptied at start.
4. `abort` (or deadline reached): abort the connector call and delete the spool; if `put` had already finished, delete the
   written file best effort (the server has told the caller it failed). A late result is never sent.
5. One log line per write: `storage.write conn=<id> kind=<k> size=<n> ok|<code> <ms>ms`: no path, no name (they can
   carry client names), no content.

Error mapping (`errors.ts`, one table per kind; each row is a unit test):

| Condition | OneDrive (Graph) | Google Drive | S3 | Local / NAS / vault |
|---|---|---|---|---|
| `auth_expired` | 401 after one refresh; refresh `invalid_grant`, `interaction_required` | 401 after one refresh; refresh `invalid_grant` | 403 `InvalidAccessKeyId`, `SignatureDoesNotMatch`, `ExpiredToken`, `InvalidToken` | — |
| `permission` | 403 `accessDenied`; parent folder missing and create refused | 403 `insufficientPermissions`, `forbidden`, `appNotAuthorizedToFile` | 403 `AccessDenied`, `AllAccessDisabled` | `EACCES`, `EPERM`, `EROFS` |
| `quota` | 507, `quotaLimitReached`, `insufficientStorage` | 403 `storageQuotaExceeded`, `quotaExceeded` | `QuotaExceeded`, `XMinioStorageFull`, 507 | `ENOSPC`, `EDQUOT` |
| `not_found` | drive or site gone (404 on the drive) | — (base folder is recreated) | `NoSuchBucket` | root missing on a local disk; vault not on this workstation |
| `unavailable` | 429, 5xx, 423 `locked`, network error, per-call timeout (20 s) | 429, 403 `userRateLimitExceeded`/`rateLimitExceeded`, 5xx, network | 503 `SlowDown`, 5xx, network | NAS not mounted (root missing below a mount point), `EIO`, `ETIMEDOUT`, `EHOSTDOWN`, `ESTALE`, `ENOTCONN` |
| `too_large` | 413 | 413 | `EntityTooLarge` | `EFBIG` |

Test connection (`probe`): writes `.guildwise-probe-<8 hex>.txt` (40 bytes) in the base folder / prefix / root / vault
folder, deletes it (vault: no commit for the probe; write and delete in the working tree only), reports `connected`, or the
typed error mapped to a health state (`auth_expired` → `needs_reauth`, `permission`, `quota`, else `unavailable`). Bounded
at 30 s.

Remove: `storage.remove` drops the entry from `storage.json` (re-sealed without it; the file is deleted when it was the last
one), cancels a live device flow, aborts transfers of that connection, and best-effort revokes the OAuth grant (Google
`https://oauth2.googleapis.com/revoke`; Microsoft has no single-token revoke for delegated grants, so local deletion only).
`storage.sync` after every reconnect removes local entries the server no longer lists, so a removal made while the
workstation was offline still deletes the token.

### 4.4 Server

| File | Content |
|---|---|
| `apps/server/src/commands/storage-connections.ts` | create, rename, remove (events); `listStorageConnections(ctx, orgId, userId)` (DTO with health + workstation online + `canConnect`); `applyStorageReport`; `applyStorageAuth`; request rows; prune. |
| `apps/server/src/routes/storage.ts` (registered in `app.ts`) | routes below |
| `apps/server/src/storage-relay/hub.ts` (`StorageRelay`, on `ctx.services.storage`) | the write relay (below) |
| `apps/server/src/runner-gateway/handlers.ts` | cases `storage.report`, `storage.auth`, `storage.write.credit`, `storage.write.result`; `command.result` for the `storage.*` commands; send `storage.sync` after `welcome`; on disconnect `storage.onDisconnect(conn)` |
| `apps/server/src/runner-gateway/gateway.ts:104` | `t.startsWith('relay.') || t.startsWith('storage.')` → paths-only logging |
| `apps/server/src/config.ts` | `AOM_STORAGE_WRITE_TIMEOUT_MS` (default 60000, clamp 5000..300000), `AOM_STORAGE_MAX_FILE_BYTES` (default 25 MiB, max 100 MiB), `AOM_STORAGE_MAX_IN_FLIGHT` (default 20) |
| logger redact paths (where pino is configured) | add `*.envelope`, `*.data` for storage frames as a second line of defence |

Routes (all `requireOrg`; manage = org Owner/Admin; connect/auth/test only by the user who owns the connection's
workstation (integrations D4); rate limits as the integrations routes):

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/org/storage/connections` | any member (read-only; GWP-64 uses it) | list DTOs; `removed` ones are not listed |
| `POST /api/org/storage/connections` `{ kind, label, workstationId }` | Owner/Admin; workstation is theirs, active, `storage:1` | 201, health `pending` |
| `PATCH /api/org/storage/connections/:id` `{ label }` | Owner/Admin | rename (server only) |
| `DELETE /api/org/storage/connections/:id` | Owner/Admin | event + `storage.remove` queued; the token is deleted when the runner gets it |
| `POST /api/org/storage/connections/:id/connect` `{ requestId, envelope }` | workstation owner; s3/local/vault | 202; 409 `workstation_offline` / `runner_key_changed` / `runner_too_old` |
| `POST /api/org/storage/connections/:id/auth` `{ siteUrl?, baseFolder? }` | workstation owner; onedrive/google_drive | 202 `{ sessionId }` (also the **Reconnect** action) |
| `POST /api/org/storage/connections/:id/auth/:sid/cancel` | workstation owner | |
| `POST /api/org/storage/connections/:id/test` `{ requestId }` | workstation owner, Owner/Admin | 202 |
| `GET /api/org/storage/requests/:rid` | the requesting user | poll: state, prompt (device code), health, error |
| `GET /api/workstations/:id/integrations` (existing) | — | already returns `key` + `serverTime` for sealing; the web reuses it |

Health shown = the reported row, overridden by `runner_offline` when the workstation is not connected (computed, not
stored).

`StorageRelay.write` (the one entry point later cards call; no HTTP route in this card):

```ts
write(req: {
  orgId: string; connectionId: string;
  folder: string; name: string; vars: Record<string, string>; ext?: string;
  contentType: string; size: number;                 // the declared size (Content-Length / multipart part size)
  source: AsyncIterable<Buffer>;                     // the request stream; never buffered whole
  signal?: AbortSignal;                              // the public client went away
}): Promise<{ ok: true; reference: StorageReference } | { ok: false; error: StorageWriteError }>
```
1. Connection unknown, removed or of another org → `not_found`. Template refused by `renderStoragePath` → `invalid`.
   `size > AOM_STORAGE_MAX_FILE_BYTES` → `too_large`. `inFlight ≥ AOM_STORAGE_MAX_IN_FLIGHT` → `unavailable`.
   Workstation not connected (`ctx.services.runners.isOnline`) → **`runner_offline`, at once** (GWP-68 keys off this).
2. Send `open`; wait for the first `credit` (≤ 10 s, else `timeout`). An early `result` (auth_expired, …) ends it.
3. Pull from `source` re-chunked to 256 KiB, hashing (sha256) and counting as it goes; send while `seq < upTo`, else await
   the next credit. More bytes than `size` → abort `too_large`. Memory held: one window (2 MiB) per transfer.
4. Send `end { size, sha256 }`; await `result`. The whole transfer has one deadline (`AOM_STORAGE_WRITE_TIMEOUT_MS`):
   on expiry send `abort` and return `timeout`. Runner disconnect mid-transfer → `unavailable` (retryable).
5. Return the reference after checking `reference.sha256 === sha256 && reference.size === size && reference.connectionId
   === connectionId` (else `invalid`). Update `storage_connection_health` (`last_ok_at`, or the state for
   `auth_expired`/`permission`/`quota`).
6. Log only `{ storage: { connectionId, kind, sizeBytes, outcome, latencyMs } }`. Nothing is written to a table except the
   health row. The caller (GWP-65/67) stores the reference on its record.

Hosted note (GWP-69): with several server instances the public request and the runner socket may sit on different
instances; GWP-69 routes `storage.write` to the instance that holds the socket. Not this card.

### 4.5 Web

| File | Content |
|---|---|
| `apps/web/src/api/queries/storage.ts` | `useStorageConnections` (poll 5 s while any is `pending`/`runner_offline` or a request is open), create, rename, remove, connect, auth, cancel, test, `useStorageRequest(rid)` (1 s while open) |
| `apps/web/src/lib/storage.ts` | pure: health → label/tone (`Connected`, `Needs re-authentication`, `Workstation offline`, `Unavailable`, `No permission`, `Storage full`, `Not set up on <workstation>`, `Not connected yet`); kind → name and help text; error code → sentence |
| `apps/web/src/components/orgsettings/StorageTab.tsx` | list (label, kind icon, workstation, state badge, last checked), row actions: **Test connection**, **Rename**, **Reconnect** (shown for `needs_reauth`, and as "Connect" for `pending`), **Remove** (confirm dialog: "The keys are deleted from <workstation>. Forms that use this connection will show a warning.") |
| `apps/web/src/components/orgsettings/StorageAddDialog.tsx` | step 1 kind + display name + workstation (only the user's own online workstations with `storage:1`); step 2 per kind: OneDrive (optional SharePoint site URL, base folder), Google Drive (base folder name; note "Guildwise can only see the folder it creates"), S3 (endpoint, region, bucket, prefix, path-style, access key id, secret: sealed with `sealForRunner`, inputs `type=password` where secret, `autoComplete="off"`, `spellCheck={false}`, cleared after sealing, never in the query cache), local folder (absolute path on the workstation), vault (vault select + folder). Device flow panel: big user code with **Copy**, **Open sign-in page** link (`target=_blank`, `rel=noopener`), countdown, "Waiting for you to sign in…", then success or the error sentence |
| `apps/web/src/pages/OrgSettings.tsx` | tab `storage` ("Storage"), visible to members (read-only) and managed by Owner/Admin |
| `apps/web/src/ws/invalidate.ts` | `case 'storage': return [['storage']]`; add `['storage']` to the `workstation` case |

All devices including touch (standing order): dialogs scroll inside the viewport when the soft keyboard opens (use the
existing dialog component; field focus scrolls into view); action buttons ≥ 44 px; `inputMode="url"` for endpoint and site
URL, plain text for path; row actions in a menu on narrow screens; the device-code panel works when the sign-in page opens
in another tab or another device (the code is shown large enough to type from a phone).

### 4.6 Docs and changelog

- `CHANGELOG.md`: add `## [1.5.0] - Unreleased` (if no 1.5.0 heading exists yet) with an **Added** entry: storage
  connections (five kinds), sign-in on the workstation, encrypted keys only there, Test connection, Needs
  re-authentication, rename/remove, the write relay that stores nothing on the server, migration number, new env vars
  `AOM_STORAGE_WRITE_TIMEOUT_MS`, `AOM_STORAGE_MAX_FILE_BYTES`, `AOM_STORAGE_MAX_IN_FLIGHT`, runner capability `storage:1`
  and the runner version.
- `docs/RUNNER.md`: data directory (`secrets/storage.json`, `tmp/storage/`), configuration keys (`storage.oauth.*`), a new
  section "Storage connections" (what is kept where, the CLI, registering your own Microsoft / Google app for
  self-hosting, troubleshooting by error code).
- `docs/ARCHITECTURE.md`: a section next to §41 "Storage relay" (frames, window, deadline, nothing persisted).
- `apps/runner/src/version.ts`: bump `RUNNER_VERSION`.

### 4.7 OAuth client registration (D9)

`apps/runner/src/config.ts` gets `storage.oauth.microsoft { clientId, tenant='common' }` and `storage.oauth.google
{ clientId, clientSecret }`, overridable by `AOM_STORAGE_MS_CLIENT_ID`, `AOM_STORAGE_MS_TENANT`,
`AOM_STORAGE_GOOGLE_CLIENT_ID`, `AOM_STORAGE_GOOGLE_CLIENT_SECRET`. Release builds inject Guildwise's public client ids
at build time (tsup `define` from CI variables); nothing is committed to the repository. Not configured → the kind's
connect answers `unsupported` with "This runner has no Microsoft (Google) app configured; see RUNNER.md". The owner
registers the two apps (asked, non-blocking); the builder works with mocked HTTP and needs no real ids.

## 5. Acceptance criteria → design → tests

All tests in **new** files. Run: shared, runner and web unit suites; server tests that need Postgres run where the test DB
is available (otherwise the builder says so and the tester runs them).

| AC | Design | Tests |
|---|---|---|
| 1. Add, test, rename, remove each kind | §4.4 routes, §4.5 tab, §4.3 connectors and probe | `apps/server/test/storage-connections.test.ts` (create/rename/remove per kind, permissions: member read-only, non-owner of the workstation cannot connect, remove queues `storage.remove`, `storage.sync` after reconnect); `apps/web/test/storage-tab.test.tsx` (add per kind, rename, remove confirm, Test shows result); runner `storage-service.test.ts` (connect + probe per kind with doubles) |
| 2. No OAuth token on the server (DB, logs, API) | D2 device flow on the runner; §4.1 nothing server-side holds it | `apps/runner/test/storage-oauth.test.ts`: mocked Microsoft and Google endpoints issue `access-TOKEN-marker` / `refresh-TOKEN-marker`; capture **every frame** the runner sends (fake socket) and the runner log → zero hits; raw `secrets/storage.json` bytes → zero hits; `SealedFile.load` → the token is there. `apps/server/test/storage-no-secrets.test.ts`: a fake runner completes the auth flow (it reports `storage.auth done` and `storage.report`), and a write runs; then scan **every table** in the test database (`information_schema.tables` in `public`, `SELECT t::text FROM <table> t`), the captured pino output and every API response body for the marker strings and for the uploaded content marker → zero hits |
| 3. Write to each kind with templates, reference returned, server stores only that | §4.2 template + reference, §4.3 write path, §4.4 `StorageRelay.write` | `packages/shared/test/storage-template.test.ts` (rendering, sanitising, reserved names, unknown key, ext); `apps/runner/test/storage-local.test.ts`, `storage-vault.test.ts` (temp dirs; vault with a temp git repo; commit made; symlink refused; clash suffix); `storage-s3.test.ts` (SigV4 vectors; an in-process `node:http` S3 double checks the signature and stores the object; MinIO when `AOM_TEST_MINIO_URL` is set, skipped otherwise); `storage-onedrive.test.ts`, `storage-gdrive.test.ts` (mocked HTTP: folder creation, upload session, reference with providerId); `apps/server/test/storage-relay.test.ts` (fake runner: chunks in order, credit window respected, sha256/size checked, reference returned; no new table rows except health) |
| 4. Unavailable → typed error in bounded time, nothing on the server | §4.3 error table, deadlines; §4.4 steps 1–5 | `apps/runner/test/storage-errors.test.ts` (each table row); S3 double stopped → `unavailable`; mock token revoked → `auth_expired` and `needs_reauth` reported; `storage-relay.test.ts`: runner offline → `runner_offline` immediately; runner silent → `timeout` within the configured deadline (fake timers) and `abort` sent; disconnect mid-transfer → `unavailable`; afterwards `inFlight === 0` and the table scan finds nothing |
| 5. Test connection result; expired → Needs re-authentication + working reconnect | §4.3 probe, `needsReauth`; §4.4 `/test`, `/auth` as reconnect; §4.5 labels | runner `storage-service.test.ts` (probe ok / typed error; expired refresh → `needs_reauth`; a new device flow on the same id clears it and keeps the config); server `storage-connections.test.ts` (report → health → DTO); web `storage-tab.test.tsx` (badge "Needs re-authentication", Reconnect opens the device panel, success clears the badge) |
| 6. Remove deletes the encrypted token on the workstation | §4.3 remove + sync | runner `storage-store.test.ts` (remove → entry gone after decrypting; last one → file gone); `storage-service.test.ts` (`storage.remove` and `storage.sync` with an unknown id delete it); server test that remove while offline is delivered at reconnect |
| 7. CHANGELOG 1.5.0 entry | §4.6 | review |

Test plan step 5 (manual on UAT with a real Google Drive) needs the Google app from D9.

## 6. Risks

| Risk | Mitigation |
|---|---|
| A late success after the server timed out leaves a file the caller thinks failed | runner deletes it best effort on abort; the caller's retry writes `-2` anyway |
| Microsoft tenant policy blocks user consent for `Files.ReadWrite.All` / `Sites.ReadWrite.All` | error sentence names "your administrator must approve the app"; RUNNER.md explains admin consent or registering the firm's own app (D9 override) |
| Google refresh tokens expire after 7 days while the OAuth app is in "Testing" | owner publishes the app (non-blocking question); `needs_reauth` shows it clearly anyway |
| `drive.file` cannot write into an existing folder or a shared drive | documented in the dialog; base folder created by the connector |
| Paths in references can contain client names | the template is the firm's choice; logs never carry paths; the reference is the only copy on the server, as the card allows |
| Vault writes keep client documents in git history even after deletion | warning in the add dialog for the vault kind |
| Memory pressure from many uploads | window 2 MiB per transfer × `AOM_STORAGE_MAX_IN_FLIGHT` (20) = 40 MiB worst case; refuse with `unavailable` above |
| A zod error echoing a chunk into the log | gateway logs paths only for `storage.*`; redact paths |
| An active malicious server (swapped key, altered JS) | same honest limit as integrations-page.md §2.3; `allow-web off` and the CLI connect path |

## 7. Recommendation

Build the five connectors in the runner on the existing `SealedFile` store and the existing sealed-envelope channel,
sign in to OneDrive/SharePoint and Google Drive with the device flow on the runner, keep only connection metadata and
health on the server, and relay writes as a credit-windowed chunk stream over the runner WebSocket with one deadline and
no persistence. Expose `ctx.services.storage.write(...)` for GWP-65 and the connection list route for GWP-64.

Follow-up (backlog suggestion): direct browser-to-storage uploads with runner-issued upload sessions for the cloud kinds
(option C), once the GWP-65 security review has settled which server-side checks are required.

> Update (GWP-147): option C (a grant for the browser) is now built for OneDrive, Google Drive and S3. See `GWP-147-direct-browser-to-storage-uploads-for-cloud-connec.md`.
