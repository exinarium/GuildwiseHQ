# GWP-40: Document vault: upload, tags and findability (release 1.4.0)

Replaces GWP-25 (mapped to the wrong repository). Scope: GuildwiseHQ only (`packages/shared`, `apps/server`,
`apps/runner`, `apps/web`, `e2e`). Guildwise Cloud and agent-org-manager are not touched.

## 1. The question

How do we let a user upload a file into an organisation or project document vault, tag documents, and search the
document list by text and tag, while:

- every vault write goes through the existing queue (`enqueueVaultWrite` → `runner_commands` → runner
  `VaultManager` → `writeVaultFile`: safe path, no symlinks, a commit in the vault repository);
- upload and search follow the existing authorisation (org membership, document write rule, project visibility through
  `visibleProjectIds` / `loadVisibleProject`);
- existing documents (no tags, no file) and existing API callers behave exactly as before?

## 2. Source material and what could not be read

- **GWP-25 investigation report: not readable.** It lives on the GWP-25 branch in agent-org-manager, which is not a
  reference repository of this project, and GWP-40 has no attachments. The card forbids rebuilding it from memory, so
  this design is built from GWP-40's requirements and acceptance criteria (which the card says are GWP-25's, carried
  over) and from the GuildwiseHQ code. The manager was asked (non-blocking) to attach the report or add agent-org-manager
  as a reference repository. **Open item for the builder:** when the report becomes readable, compare it against
  section 3 and section 5 below and raise any scope difference on the card (GWP-25's ACs win; do not resolve alone).
- Ledger: no earlier decision on document upload, tags or search. Related: GWP-29 renames "Vault" to "Knowledge" in
  the UI (ledger 52b52509); this design keeps all new UI text out of `Vaults.tsx` and the nav, so there is no conflict.
- Standing order "GuildWise ... does not keep user data; no server-hosted vault content": see risk R1.

## 3. Path check (AC 2): every path from the card, brief and planning note, checked against GuildwiseHQ

| Path / symbol (as given) | In GuildwiseHQ | Note / correction |
|---|---|---|
| `packages/shared/src/documents/index.ts` (DocumentKind, DocumentStatus, ListDocumentsQuery, documentVaultPath, renderDocumentFile, DocumentDto) | yes (lines 7-158) | `ListDocumentsQuerySchema` :112, `documentVaultPath` :54, `renderDocumentFile` :59, `DocumentDtoSchema` :122. No tags, no file, no search yet. |
| `packages/shared/src/events/document.ts` | yes | Not named on the card; the document events live here (event-sourced model). Must change. |
| `apps/server/src/routes/documents.ts` (documentRoutes) | yes | 70 lines, JSON routes only. |
| `apps/server/src/commands/documents.ts` (createDocument, listDocuments, getDocument, saveDocumentVersion, changeDocumentStatus, publishDocument) | yes | `listDocuments` :212 uses `visibleProjectIds`; `publishDocument` :376 calls `enqueueVaultWrite`. |
| `apps/server/src/projections/documents.ts` | yes | Not named on the card; the `documents` table is a projection of `Document*` events. Must change. |
| `apps/server/migrations/2341_documents.sql` | yes | The schema to extend. Latest migration today: `2742_video_submit_captions.sql`. |
| `apps/server/src/commands/vaults.ts` `enqueueVaultWrite` | yes (:511) | Not named on the card by file. |
| `apps/server/src/routes/card-attachments.ts`, `commands/card-attachments.ts` | yes | **Correction:** the upload is *not multipart*. It is a raw body (`application/octet-stream`, name in `?name=`), parsed by a plugin-scoped `addContentTypeParser('*', { parseAs: 'buffer' })`. |
| `MAX_ATTACHMENT_BYTES`, `MAX_CARD_ATTACHMENT_BYTES`, `MAX_CARD_ATTACHMENTS`, `checkAttachment`, `safeAttachmentName` | yes, `packages/shared/src/attachments/index.ts` :11-13, :140, :160 | **Correction:** the limits and type checks live in `@aom/shared`, not in the server files. `MAX_CARD_*` are per card and do not apply to documents. |
| `apps/server/src/auth/origin-check.ts` | yes (:52-58) | Not named on the card. **Trap:** non-JSON mutations get 415 unless the path is listed here. The upload path must be added. |
| `apps/server/src/browser-gateway/visibility.ts` `DOCUMENT_EVENTS` | yes (:131) | Not named on the card. A new document event must be added so session-private documents stay private. |
| `apps/runner/src/vaults/write.ts` (writeVaultFile, isSafeVaultPath, refuseSymlinks) | partly | `writeVaultFile` :26 and `refuseSymlinks` :86 (module-private, not exported). **Correction:** `isSafeVaultPath` is in `packages/shared/src/vaults/index.ts:102`. `writeVaultFile` is text-only (`readFile(..., 'utf8')`, `content: string`). |
| `VaultManager.write` | `apps/runner/src/vaults/manager.ts:332` | **Correction:** not in `write.ts`. |
| runner command dispatch / schemas | `apps/runner/src/runner.ts:1908`, `packages/shared/src/protocol/runner.ts:863` (`CommandPayloadSchemas`) | Not named on the card. Unknown commands are answered "not supported by this runner version" (runner.ts:2117). |
| runner HTTP to server | `apps/runner/src/attachments/index.ts:38` (`ServerHttp`), constructed at `runner.ts:372` | Not named on the card; reused to fetch file bytes. |
| `apps/web/src/pages/Documents.tsx` (DocumentsList, DocumentView) | yes | Both components are in this file (DocumentView :104). |
| `DocumentBody` | `apps/web/src/components/discovery/DraftPanel.tsx:30` | **Correction:** not in `Documents.tsx`. |
| `apps/web/src/api/queries/documents.ts` (useDocuments, useDocument) | yes | |
| `apps/web/src/api/client.ts` (upload) | yes (:80) | Raw-body upload; path may already carry a query (`?` handled). |
| `apps/web/src/api/queries/attachments.ts` (uploadAll) | yes | Pattern only; not changed. |
| `apps/web/src/pages/Vaults.tsx` (VaultCard, RegisterVault) | yes (VaultCard :103, RegisterVault :277) | **Not changed** by this design (no upload entry point there; avoids GWP-29). |
| `apps/web/src/components/blog/SocialCaptionsEditor.tsx` `TagInput` | yes (:47, module-private) | Pattern for a chip/tag input. |
| `e2e` (@aom/e2e) | `e2e/tests/*.spec.ts` | No documents spec yet; `discovery.spec.ts` visits `/documents`. New `e2e/tests/documents.spec.ts`. |
| GWP-25 report paths | **not checked** | Report unreadable (section 2). Paths that exist only in agent-org-manager cannot be named until it is. |

Existing callers of the documents API (checked for regression): `apps/web/src/pages/Documents.tsx`,
`apps/web/src/components/discovery/DraftPanel.tsx`, `apps/web/src/components/boardroom/MinutesPanel.tsx`,
`apps/web/src/router.tsx`, `apps/web/src/components/shell/nav-config.ts`, `apps/web/src/help/page-help-content.ts`,
server tests `documents`, `discovery`, `boardroom`, `r2-sessions`, `r2-limits`, `r2-handoff-skills`, web tests
`discovery.test.tsx`, `boardroom.test.tsx`, e2e `discovery.spec.ts`. Server-side producers: `sessions/discovery*.ts`,
`sessions/board.ts` (they call `versionEvent` / create documents). Guildwise Cloud does not reference documents.

## 4. Findings

1. **Documents are event-sourced text.** `DocumentCreated`, `DocumentVersionSaved`, `DocumentStatusChanged`,
   `DocumentPublishQueued` project into `documents` + `document_versions`. A version is the whole markdown text
   (≤ 400 000 chars). Only Owners/Admins write (`assertManager`); reading needs project membership for project documents
   (`loadDocument`), and the list filters with `visibleProjectIds`.
2. **Publishing** happens on approval: the projection sets `publish_state='pending'`, `publishDocument` renders
   `renderDocumentFile` (frontmatter + text) and enqueues one `vault.write` (`mode: 'replace'`) to
   `<project folder>/docs/<slug>.md` or `org/docs/<slug>.md`. `publishPendingDocuments` retries.
3. **The vault write path is text-only.** `VaultWriteCommandSchema.content` is a string; `writeVaultFile` reads and
   writes UTF-8. A binary file cannot go through `vault.write` without corruption. Runner commands are JSON rows in
   `runner_commands` (uuidv7 ids, delivered FIFO per workstation; `VaultManager.serialize` runs one write per vault at a
   time). Putting 20 MB of base64 into a command row and a WebSocket frame is not reasonable.
4. **The attachment pattern already solves bytes:** raw-body upload, `checkAttachment` (allow-list of extensions,
   executable refusal by extension and magic bytes, content/extension match, 20 MB), bytes in an operational table
   outside the event log (`card_attachment_data`), events carry metadata only, served with `serveAttachment`
   (sandbox CSP, `nosniff`, images inline only), and the runner fetches bytes over HTTP with its runner token
   (`GET /api/runner/attachments/:id`), authorised by what the workstation is entitled to.
5. **Search conventions:** `ILIKE` with escaping (`escapeLike`, `apps/server/src/queries/cards.ts:471`). No
   full-text index is used elsewhere for this kind of list; document counts per org are small.

## 5. Options

### 5.1 What an uploaded file becomes

| Option | Summary | Verdict |
|---|---|---|
| A. Text only | Only `.md/.markdown/.txt` uploads; the text becomes version 1 of a normal document. | Too narrow for a "document vault" (PDF, DOCX, images are the common case). |
| B. Any allowed attachment type as a stored file (**recommended**) | Text files (`md`, `markdown`, `txt`) become normal documents (text = version 1). Every other allowed type is stored as a *file document*: bytes on the server like card attachments, a markdown sidecar plus the original file published to the vault. | Covers the real use, reuses the attachment checks and limits, keeps one document model. |
| C. Separate "vault files" model | A new table/page for files, outside documents. | Duplicates list, tags, search and visibility; the card wants them in the document list. |

### 5.2 How the bytes reach the vault

| Option | Summary | Verdict |
|---|---|---|
| 1. Base64 in `vault.write` | Add `encoding: 'base64'`. | 27 MB JSON rows/frames; an **old runner would silently strip the unknown field and write the base64 text** (zod strips unknown keys). Rejected. |
| 2. New `vault.write_file` command; the runner downloads the bytes (**recommended**) | Command carries `documentId`, `sha256`, `size`, `path`; runner fetches `GET /api/runner/document-files/:id` with its token, verifies size and hash, writes and commits through the same safe-path / no-symlink / commit code. | Small commands, same queue, old runners answer "not supported" (a failure, never a wrong file). |

### 5.3 Upload flow: draft or published straight away

AC 3 requires the upload to be *written to the vault*. Options: (a) uploads start as drafts and reach the vault on
approval; (b) an upload is a finished document: it is created and approved in one step and published at once
(**recommended**; only Owners/Admins can upload, and they are the ones who approve). The trail stays honest: the
server appends `draft → in_review → approved` (two `DocumentStatusChanged` events, note `uploaded`), so the allowed
transitions are respected. Reopen works as for any document.

### 5.4 Tag filter semantics

Several selected tags combine with **AND** (a document must carry all of them): it narrows, which is what a filter is
for, and is one `@>` on a GIN index. OR is a follow-up if GWP-25 asks for it.

## 6. Recommendation and design

Option B + option 2 + upload-approves (5.3) + AND tags.

### 6.1 Data model (one additive migration, next free number, e.g. `2750_document_tags_files.sql`)

```sql
-- Tags and uploaded files on documents (projection columns; existing rows get no tags and no file).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_name text;           -- null: an authored (text) document
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_content_type text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_size bigint;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_sha256 text;
CREATE INDEX IF NOT EXISTS documents_tags ON documents USING gin (tags);
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('brief','prd','minutes','session_log','file'));
-- The bytes of an uploaded file: operational (never in the event log, kept over a projection rebuild), like
-- card_attachment_data. No foreign key to documents (a projection TRUNCATE ... CASCADE must not empty it).
CREATE TABLE IF NOT EXISTS document_file_data (
  document_id uuid PRIMARY KEY,
  data        bytea NOT NULL
);
```

Check the auto-generated constraint name on a real database (`\d documents`) before relying on `documents_kind_check`.
Check `projections/rebuild.ts` (the SAVED / operational-table guard) accepts the new table; with no FK it is never
cascaded.

### 6.2 Shared (`packages/shared`)

`documents/index.ts`:

- `DOCUMENT_KINDS` gets `'file'` (label "Uploaded file"). Existing kinds unchanged.
- Tags: `DOCUMENT_MAX_TAGS = 20`, `DOCUMENT_TAG_MAX = 40`; `normalizeDocumentTag(raw)` = NFKC, trim, lowercase,
  inner whitespace → `-`, keep `[a-z0-9-_.]` plus letters (`\p{L}`), drop empty; `normalizeDocumentTags(list)` =
  normalise, dedupe keeping first order, refuse more than 20 (`badRequest('too_many_tags')` on the server).
- `DOCUMENT_TEXT_UPLOAD_EXTENSIONS = ['md', 'markdown', 'txt']`.
- `documentFileVaultPath(slug, ext, projectFolder?)` → `<folder>/docs/files/<slug>.<ext>` or `org/docs/files/<slug>.<ext>`.
- `renderDocumentFile` gets optional `tags?: readonly string[]` and `file?: { path: string; name: string }`:
  `tags: ["a", "b"]` (each `JSON.stringify`'d) only when non-empty, `file: "files/<slug>.<ext>"` and
  `file_name: "<original>"` only for a file document. **No tags and no file → byte-identical output** (unit test pins
  today's output).
- `CreateDocumentRequestSchema` gets `tags: z.array(z.string().max(80)).max(20).optional()`.
- `SetDocumentTagsRequestSchema = z.object({ tags: z.array(z.string().max(80)).max(20) })`.
- `ListDocumentsQuerySchema` gets `q: z.string().trim().max(200).optional()` and
  `tags: z.string().max(1000).optional()` (comma-separated; avoids repeated-key querystring parsing).
- `UploadDocumentQuerySchema = z.object({ name, projectId?, kind? (default 'file'), title? (≤200), tags? (comma list) })`.
- `DocumentDtoSchema` gets two **optional** fields: `tags: z.array(z.string()).optional()` (present only when non-empty)
  and `file: DocumentFileDtoSchema.optional()` (`{ name, contentType, size, sha256, image }`, present only for a file
  document). This keeps the response of an untagged authored document **byte-identical** (AC 7). The web reads
  `d.tags ?? []`.
- `DocumentTagCountDtoSchema = { tag, count }` for the tag list.

`events/document.ts`:

- `DocumentCreated` payload: optional `tags: z.array(z.string()).max(20).optional()` and optional
  `file: { name, contentType, size, sha256 }`. Old events replay unchanged.
- New `DocumentTagsChanged { docId, tags: string[] (max 20), by: Id.nullable() }` (whole set, not a diff).

`vaults/index.ts` + `protocol/runner.ts`:

- `VaultWriteFileCommandSchema = { vaultId, path, documentId: uuid, sha256: /^[0-9a-f]{64}$/,
  size: int 1..MAX_ATTACHMENT_BYTES, commitMessage, push: boolean default true }`; register as
  `'vault.write_file'` in `CommandPayloadSchemas` and the command-name list.

### 6.3 Server (`apps/server`)

**Projection** (`projections/documents.ts`):

- `DocumentCreated`: also insert `tags` (`p.tags ?? []`) and the four `file_*` columns.
- New `DocumentTagsChanged`: `UPDATE documents SET tags=$2, updated_at=$3, publish_state = CASE WHEN status IN
  ('approved','handed_off') AND publish_version IS NOT NULL THEN 'pending' ELSE publish_state END WHERE id=$1`
  (a tag change on a published document re-publishes the sidecar so the vault frontmatter matches).
- `DocumentVersionSaved` / `DocumentStatusChanged` are **not** changed: they never touch `tags`, so tags survive
  versions and status changes by construction (tested).
- Register the new event in `browser-gateway/visibility.ts` `DOCUMENT_EVENTS`.

**Commands** (`commands/documents.ts`):

- `documentDto`: add `...(r.tags?.length ? { tags: r.tags } : {})` and
  `...(r.file_name ? { file: { name, contentType, size: Number(r.file_size), sha256, image: /^image\//.test(ct) } } : {})`.
- `createDocument`: accepts `tags` (normalised) into `DocumentCreated`.
- `setDocumentTags(ctx, who, docId, req)`: `assertManager`; `loadDocument(tx, who, docId, true)` (visibility → 404);
  normalise; equal set → return unchanged, no event; else append `DocumentTagsChanged`. After the transaction, if the
  document is approved/handed_off, `publishDocument(ctx, docId).catch(warn)` like `changeDocumentStatus`. Allowed in
  every status (tags are metadata, not content).
- `uploadDocument(ctx, who, { name, bytes, projectId?, kind, title?, tags })`, all inside one `withAppendTx`:
  1. `assertManager(who)` → 403 `only an Owner or an Admin can change documents`.
  2. `projectId` → `loadVisibleProject` (+ `org_id === who.orgId`), else 404 `project not found`.
  3. `safeAttachmentName(name)`; `checkAttachment(name, bytes)` → on failure 422 `document_rejected` with the reason
     (empty, > 20 MB, executable, not an allowed type, content does not match the extension).
  4. Text upload (`md/markdown/txt`): decode with `new TextDecoder('utf-8', { fatal: true })` (invalid → 422), strip a
     BOM, length ≤ `DOCUMENT_MAX_CHARS` (else 422 `document_too_long`); version 1 content = the text; no file row.
  5. Other types: `INSERT INTO document_file_data (document_id, data)`; `DocumentCreated.file` = metadata; version 1
     content = `''`.
  6. Title = `title` or the file name without its extension (≤ 200), slug via `uniqueSlug`; tags normalised.
  7. Append `DocumentCreated`, `versionEvent(..., 1, ...)`, `DocumentStatusChanged draft→in_review` and
     `in_review→approved` (version 1, `by: who.userId`, note `uploaded`).
  8. After commit: `publishDocument(ctx, docId).catch(warn)`; return `getDocument`.
  Any refusal throws before anything is stored, and the vault command is only enqueued after commit, so a rejected
  upload writes nothing to the server or the vault (AC 4).
- `changeDocumentStatus` → approved: skip the `document_empty` check when the document has a file (a file document's
  text is an optional note).
- `publishDocument`: when `d.file_name` is set, compute `ext = attachmentExtension(file_name)`,
  `filePath = documentFileVaultPath(slug, ext, folder)`, enqueue **first** a `vault.write_file` (path, documentId,
  sha256, size, commit message `docs: file <title>`), **then** the existing `vault.write` of the sidecar
  `<folder>/docs/<slug>.md`, rendered with `tags` and `file: { path: 'files/<slug>.<ext>', name }`. Both go to the same
  workstation: split `enqueueVaultWrite` into `vaultWriteTarget(db, vaultId)` (local vs synced, `chooseVaultWriteTarget`)
  plus enqueue, and add `enqueueVaultFileWrite` next to it in `commands/vaults.ts`. uuidv7 ids keep them FIFO. Authored
  documents take exactly today's path (only `tags` added to the render, which is a no-op when empty).
- `listDocuments`: two extra parameters appended to the existing query, so a call without `q`/`tags` returns exactly
  today's rows in today's order:
  ```sql
  AND ($8::text[] IS NULL OR d.tags @> $8)
  AND ($9::text[] IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest($9::text[]) AS t(p)
         WHERE NOT (d.title ILIKE t.p OR COALESCE(d.file_name,'') ILIKE t.p
                    OR EXISTS (SELECT 1 FROM document_versions v WHERE v.document_id = d.id
                                AND v.version = d.current_version AND v.content ILIKE t.p))))
  ```
  `$8` = normalised tags or null; `$9` = whitespace-split terms (max 8), each `%${escapeLike(term)}%`, or null. Every
  term must match the title, file name or current text (AND). The visibility clause
  `(d.project_id IS NULL OR d.project_id = ANY($2))` is untouched, so invisible projects never return (AC 6). Move
  `escapeLike` from `queries/cards.ts` to `db/sql.ts` and import it in both places.
- `listDocumentTags(ctx, who)`: `SELECT t AS tag, count(*) FROM documents d, unnest(d.tags) t WHERE <same org +
  visibility clause> GROUP BY t ORDER BY count DESC, t LIMIT 200`.
- `readDocumentFile(ctx, who, docId)`: `loadDocument` (visibility) then the bytes; `readDocumentFileForRunner(ctx,
  workstationId, docId)`: allowed only when `runner_commands` holds a `vault.write_file` for this workstation and this
  document (`type='vault.write_file' AND payload->>'documentId'=$2 AND status IN ('pending','sent')`), else 404.

**Routes** (`routes/documents.ts`):

| Method / path | Body / query | Response |
|---|---|---|
| `GET /api/documents` | + optional `q`, `tags` | `{ documents }` (unchanged shape) |
| `GET /api/documents/tags` | — | `{ tags: [{ tag, count }] }` |
| `POST /api/documents/upload` | raw body; query `UploadDocumentQuerySchema` | 201 `{ document }` |
| `PUT /api/documents/:id/tags` | `{ tags }` | `{ document }` |
| `GET /api/documents/:id/file` | `?download` | the bytes via `serveAttachment` (export it or move it to a shared `routes/serve-file.ts`) |
| `GET /api/runner/document-files/:id` | runner Bearer token (`runnerOf`; export it from `card-attachments.ts` or move it) | `application/octet-stream` |

The two raw-body/bytes routes go in a nested plugin (`fastify.register(async (inner) => { inner.addContentTypeParser('*',
{ parseAs: 'buffer', bodyLimit }) ... })`) so the JSON routes keep JSON parsing. `bodyLimit = MAX_ATTACHMENT_BYTES +
64 KiB` (same as attachments; Fastify answers 413 above it, which the web client already maps to "The file is too
large"). Add `/^\/api\/documents\/upload$/` to the raw-body exceptions in `auth/origin-check.ts` (the origin check
itself still applies).

### 6.4 Runner (`apps/runner`)

- `vaults/write.ts`: extract the commit tail of `writeVaultFile` into `commitVaultPath(dir, path, message)`; add
  `writeVaultBinary(dir, cmd, bytes, opts)` that does `isSafeVaultPath` + `refuseSymlinks` first, treats an existing
  file with identical bytes as success without a commit, writes the `Buffer`, and commits (or not, for a local vault).
- `vaults/manager.ts`: `writeFile(cmd, fetchBytes)` mirrors `write` (serialize per vault, local vs cloned, push via
  sync, paused handling). Before fetching, hash the existing file: equal to `cmd.sha256` → no-op without a download.
  After fetching, refuse when `size`/`sha256` differ (`VaultWriteError('the file does not match')`).
- `attachments/index.ts` `ServerHttp.documentFile(documentId)` → `GET /api/runner/document-files/:id`.
- `runner.ts`: `else if (command === 'vault.write_file') done(true, await this.vaults.writeFile(parsed, (id) =>
  this.serverHttp.documentFile(id)))`.

### 6.5 Web (`apps/web`) — all devices, including touch

- `api/queries/documents.ts`: `useDocuments` filter gains `q?: string`, `tags?: string[]` (sent as `tags=a,b`);
  `useDocumentTags()`; `useSetDocumentTags(id)` (`put`); `useUploadDocument()` (`upload('/documents/upload?' + qs, file)`,
  invalidates `['documents']`); `documentFileUrl(id, download)`.
- `pages/Documents.tsx` `DocumentsList`:
  - `KIND_LABEL.file = 'Uploaded file'`; subtitle mentions uploads.
  - Search: `<input type="search" inputMode="search" enterKeyHint="search" aria-label="Search documents">`, debounced
    (~300 ms), full width on small screens, at least 44 px tall.
  - Tag filter: chips from `useDocumentTags()` (multi-select, `FilterChip pressed`), wrapping on small screens;
    "Clear filters" when any is set. Existing kind and status chips stay.
  - Upload button (only `useCanManageOrg()`): opens a `Dialog` with the file picker (`<input type="file">` with an
    `accept` list built from `ATTACHMENT_KINDS`, which on phones offers camera/files), title (prefilled from the file
    name), where (organization or one of `useProjects()`), kind (`file` default), and a tag input (chips; Enter or
    comma adds; `enterKeyHint="done"`, `autoCapitalize="none"`; remove buttons ≥ 44 px). Errors are shown inline in the
    dialog (`ErrorBox` with the server's reason), never only as a toast. Keep the dialog scrollable when the soft
    keyboard opens (the tag field is at the bottom).
  - Rows: tag badges (max ~3 then `+n`) and, for a file document, a file icon and the file name.
  - Empty state when a search/filter finds nothing: "No documents match" with a clear-filters action.
- `DocumentView`: tags under the header; "Edit tags" for managers (inline chip editor, Save/Cancel). For a file
  document: a file panel (name, `formatBytes(size)`, type, **Download** link to `/api/documents/:id/file?download=1`,
  inline preview for images via `<img src=/api/documents/:id/file>`); the note text (if any) is shown below with
  `DocumentBody`. The "Approve" button keeps working for file documents with an empty note.
- Extract a small shared `TagInput` (pattern of `SocialCaptionsEditor.tsx`) under `components/` for the dialog and the
  view.
- `help/page-help-content.ts` and `docs/USER-GUIDE.md` (Documents paragraph): one or two sentences on upload, tags and
  search. No change to `Vaults.tsx` or `nav-config.ts`.

## 7. Risks

- **R1 Standing order (no server-hosted vault content).** Uploaded bytes are kept on the server (like card attachments
  and like today's document texts) so the document view can download them and the publish can be retried. If the owner
  reads the standing order as forbidding that, the follow-up is to purge `document_file_data` once the
  `vault.write_file` command is `done` and show "in the vault at <path>" instead of Download. Raised in the handoff;
  not built here.
- **R2 Storage growth.** No per-org cap exists for documents; each file ≤ 20 MB. Follow-up suggestion: an org quota.
- **R3 Old runners** answer `vault.write_file` with "not supported": the command fails, the sidecar is still written,
  the document shows `queued`. Acceptable; the runner update fixes it.
- **R4 Search cost.** `ILIKE` over current versions is a scan per org; fine at today's sizes. A trigram index is the
  follow-up if lists grow.
- **R5 Constraint name** of the kind CHECK may differ on old databases; the migration must drop it by its real name.
- **R6 GWP-25 report unread** (section 2): scope may differ (for example content search or OR semantics).
- **R7 `approved_at` in the frontmatter** comes from `updated_at`, so a tag edit on an approved document changes it.
  Cosmetic; leave as is unless review objects.

## 8. Acceptance criteria → design

| AC | How it is met | Tests |
|---|---|---|
| 1. GWP-25 ACs copied and each passes; unmeetable ones listed | The card's ACs are GWP-25's (per the card). All map below. GWP-25 report unread → listed as open (section 2). | Builder walks every AC in the handoff. |
| 2. Paths from the GWP-25 report checked, corrected list recorded | Section 3 (card/brief/planning paths checked and corrected); report paths open until the report is readable. | — |
| 3. Upload from the web app into a project vault, in the list, written through the vault write path | `POST /api/documents/upload` → approved document → `publishDocument` → `vault.write_file` + `vault.write` → runner `writeVaultBinary`/`writeVaultFile` (safe path, no symlinks, commit). Upload dialog on Documents. | server: upload success, both commands queued with the right paths; runner: `writeVaultBinary` commits, refuses `../x` and a symlinked `docs`; web: upload dialog success; e2e. |
| 4. Too large / disallowed type / no project access rejected, nothing written | `bodyLimit` 413; `checkAttachment` 422; `assertManager` 403; `loadVisibleProject` 404; all before any insert; vault command only after commit. | server: each case asserts no `documents` row, no `document_file_data` row, no `vault.write*` command; web: dialog shows the error. |
| 5. Tags at upload, edited later, kept across versions and status changes, shown in list and view | `tags` on upload/create, `PUT /:id/tags`, `DocumentTagsChanged`; version/status projections never touch `tags`; DTO `tags`; list badges and view editor; sidecar frontmatter. | shared: render with/without tags; server: set → save version → change status → still there, rebuild keeps them; web: list and view show/edit. |
| 6. Text search + one or more tags + kind/status; never invisible projects | `q` and `tags` in `listDocuments` with the unchanged visibility clause; `listDocumentTags` uses the same clause. | server: q by title/file name/content, tags AND, tags+kind+status, a tagged doc in a project the user is not a member of never returns (list and tag counts); e2e with a second user. |
| 7. Untagged documents unchanged; callers without new parameters get the same response | Optional DTO fields omitted when empty; SQL unchanged when `q`/`tags` absent; render byte-identical without tags/file; migration defaults. | server: a document created the old way has the exact same JSON keys as before (snapshot of keys), publishes the same content; shared: render snapshot. |
| 8. Tests pass with existing documents, vault, attachment tests | New tests per row above; existing `documents`, `vaults`, `vault-write-commands`, `card-attachments`, runner `vault-write`, web `discovery`, `attachments`. | Builder runs them (unit/server suites); e2e left to testers if the sandbox cannot run it. |

## 9. Build order for the builder

1. Shared (schemas, tags, render, command schema) + unit tests.
2. Migration + projection + events visibility + `documentDto` + list search/tags + tags endpoint + server tests.
3. Upload command/route/origin check + file serving + publish split + runner endpoint + server tests.
4. Runner `vault.write_file` + tests.
5. Web list/search/tags/upload/view + tests; user guide and page help.
6. e2e `documents.spec.ts` (upload, tag, find by text and tag, open, second user cannot find it).
