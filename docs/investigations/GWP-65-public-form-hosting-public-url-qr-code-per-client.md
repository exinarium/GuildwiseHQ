# GWP-65 Public form hosting: public URL, QR code, per-client links, submission to firm storage, and security review

Status: design, revised 2026-11-04 after GWP-63 (storage connectors) and GWP-64 (forms builder) landed in the working
branch. Repository: GuildwiseHQ only (hosted ingress and rate settings are GWP-69). The runner-offline flow is GWP-68;
this card defines only the hook it plugs into.

## 0. Assumption review against the landed code (2026-11-04)

The first version of this design was written before GWP-63 and GWP-64 landed. Each assumption (§8) was checked against
the code now on the working branch. Sections changed by the review are marked **(revised)**.

| # | Assumption | Result | Where checked | What changes |
|---|---|---|---|---|
| 1 | `ctx.services.storage.write(req)` with source/size/signal/vars, `runner_offline` at once | **holds** | `apps/server/src/storage-relay/hub.ts` (`StorageWriteRequest`, `StorageWriteResult`), `context.ts` `Services.storage`, wiring in `app.ts` ~537 | none. Note: the relay itself checks the sha256 and size against the runner's receipt and returns `invalid` on a mismatch; it also returns `too_large` when more bytes arrive than declared, so the route's own byte counter is a second guard, not the only one |
| 2 | `renderStoragePath` vars and empty → `_` | **holds** (with a detail) | `packages/shared/src/storage/index.ts` `STORAGE_TEMPLATE_KEYS`, `fill`, `sanitizeStorageSegment` | none in the design. Detail for the builder: a key that is **missing** (`undefined`) is an error (`no value for {x}`), an empty string is fine; a segment that ends up empty becomes `_`. So the server always passes all nine keys (`journey: ''` for no journey) |
| 3 | `StorageReference` shape | **holds** | `StorageReferenceSchema` (`v:1, connectionId, kind, path, providerId?, size, sha256, contentType, writtenAt`) | none |
| 4 | Connection names its workstation, `ctx.services.runners.isOnline` | **holds** | `storage_connections.workstation_id` (migration 2810), `RunnerRegistry.isOnline` (`runner-gateway/registry.ts`) | none. The presence check at start reads `SELECT id, workstation_id FROM storage_connections WHERE id = ANY($1) AND org_id=$2 AND status='active'`; a missing/removed connection is `destination_missing` (non-retryable), an offline workstation is the offline hook |
| 5 | Forms versioned per org, `FormDefinition` zod schema, a published version is pinned | **holds** | migration 2820 (`forms`, `form_versions`), `FormDefinitionSchema` (`packages/shared/src/forms/schema.ts`), `saveForm` (every save is a new immutable version), `getFormVersion` (`apps/server/src/queries/forms.ts`) | none. Addition: a form can be **archived** (`forms.status='archived'`); an archived form is treated like an unpublished one (same 404) |
| 6 | Shared `validateAnswers(def, answers, files)` → field + code | **does not hold as written** | `packages/shared/src/forms/validate.ts` | real function is `validateFormAnswers(def, answers, { strict })`; files are answers (`FormFileAnswer {name, size, type}`) under the field id; the result is `{ ok, errors: Record<fieldId, {code, message}>, unknown: string[] }`. See §4.2 (revised) |
| 7 | File field `allowedTypes` (extensions), `maxBytes`, `destination {connectionId, folder, name}`; form `answersDestination`, `logo`, `confirmationText` | **partly** | `FormFieldSchema`, `FormSettingsSchema`, `newFormField`, `newFormDefinition` | `maxSizeBytes` (not `maxBytes`, ≤ 25 MiB); `allowedTypes` entries are `.ext` **or** MIME patterns (`image/png`, `image/*`); `destination.connectionId` is **nullable**; fields are keyed by `id`; settings live under `definition.settings` (`title`, `description`, `logo: {imageId, alt} | null`, `answersDestination`, `confirmationText`); defaults already exist (answers `Forms/{form}` / `{date}-{submission}`, files `Forms/{form}/{submission}` / `{field}-{original}`). See §3.3, §4.2, §4.3, §4.7 (revised) |
| 8 | Logo is an org branding asset readable through a GWP-64 function | **holds** | `org_brand_images`, `readFormLogo(ctx, orgId, imageId)` → `{contentType, data}` (`apps/server/src/commands/forms.ts`); `/api/forms/logos/:imageId` needs a login | none: the public logo route calls `readFormLogo` with the publication's org and the published version's `settings.logo.imageId` |
| 9 | Renderer is a React component without the app shell, router, auth client or extension, using classes not `style` attributes | **partly** | `apps/web/src/components/forms/FormRenderer.tsx` | it needs no provider and has no `style` attribute (the strict CSP without `unsafe-inline` stands), but its API is self-contained: it keeps the answers in its own state, `onSubmit(answers)` is synchronous and it shows the "done" screen at once, and for a file it keeps only `{name, size, type}`, not the `File`. The public page needs additive props. See §4.5 (revised) |

Not part of the numbered list, but found while checking: `CHANGELOG.md` already has a `## [1.5.0]` heading (add under
it); the next free migration number is still `2830`; GWP-64's write routes use `requireOrg(ctx, req, { min: 'admin' })`
(use the same for publish and client links); `streamId.form(formId)` exists and the form events live in
`packages/shared/src/events/form.ts`.

## 1. The question

A firm publishes a form it built (GWP-64). Clients open it from a public URL, a QR code or a personal link, fill it in
without a Guildwise login, and the answers and uploads land in the firm's own storage through the firm's runner (GWP-63).
The server keeps nothing but a submission reference. We need:

1. the public URL and QR code, publish and unpublish;
2. per-client links: signed, expiring, revocable, single client, no personal data in clear text;
3. the public page: which bundle, which headers, how it validates;
4. the submission protocol: streaming uploads, the answers file, retry without retyping, never a false "complete";
5. the runner-offline hook;
6. the security controls and a threat model (written below in §6, committed by the builder as
   `docs/security/public-forms.md`).

Planner questions answered here: token signing format (§3.2), bot protection (§3.4), submission file format (§3.3),
virus scanning (§3.6: follow-up, not in scope).

## 2. Findings in the code

| Where | What is there | Use for this card |
|---|---|---|
| `apps/server/src/webhook-relay/route.ts` | Public route registered **without** fastify-plugin, own content parser and error handler, `logLevel: 'silent'`, lookup in `onRequest` before the body is read, rate limit in `preHandler`, empty bodies on errors, metadata-only rows | **Pattern** for `apps/server/src/public-forms/routes.ts` |
| `apps/server/src/webhook-relay/hub.ts` `takeToken` | In-memory token bucket per key, `retryAfterSec` | Same bucket maths in a small keyed class (per IP hash, per form). Do not refactor `RelayHub` |
| `apps/server/src/auth/secrets.ts` `signingKey(ctx, purpose)`, `signValue`/`verifySigned` | HMAC key derived from `AOM_SECRET_KEY` (or the DB key) per purpose | **Reuse** `signingKey` for client-link and session tokens |
| `apps/server/src/video/media-url.ts` | HMAC-signed, expiring URL, `timingSafeEqual`, 404 without a hint | Same verification shape |
| `apps/server/src/crypto.ts` | `randomToken(bytes)` base64url, `sha256Hex` | Public id = `randomToken(16)` |
| `apps/server/src/assistant/limits.ts` | Signed stateless proof-of-work challenge (16 bits, about a second in a browser), salted IP hash `ipHash` | **Pattern** for bot protection; the form session token doubles as the PoW challenge |
| `packages/shared/src/attachments/index.ts` | `executableMagic`, `magicMatches`, `safeAttachmentName`, `EXECUTABLE_EXTENSIONS` (module private) | **Export** and reuse for the upload content check on the first bytes of the stream |
| `apps/server/src/app.ts` `contentSecurityPolicy`, `onSend` security headers, `LOG_REDACT`, `redactUrl`, `bodyLimit: 2 MiB` | App CSP has `style-src 'unsafe-inline'`; the hook sets a CSP only if the route has not; URL redaction in the request serializer | Public page sets its **own** stricter CSP; add redaction for `/f/…` and the answers keys |
| `apps/server/src/auth/origin-check.ts` | Origin check on every non-GET `/api/*`; `checkContentType` allows only JSON except listed upload paths (`/api/forms/logos`, `/api/documents/upload`, …) | Keep the Origin check for the public API (same origin page); add the part-upload path (`^/api/public/forms/[^/]+/submissions/[^/]+/parts/\d+$`) to the raw-body exemptions |
| `apps/server/src/routes/documents.ts` upload | Buffers the whole body (`parseAs: 'buffer'`) | **Do not copy**: uploads here must stream |
| `apps/web/src/components/security/QrCode.tsx` | `qrcode-generator`, inline SVG, no network | Reuse for the publish panel; add SVG/PNG download |
| `apps/web/vite.config.ts` | One rollup input (`index.html`); landing/legal pages are extra built files the server sends | Add a second input `form.html` for a small public bundle |
| `apps/web/public/sw.js` | Network-first for navigations, never caches `/api/` | No change needed; `/f/*` navigations go to the network |
| `apps/server/test/relay-no-content.test.ts` | Sentinel strings, dump of every table with `SELECT t::text`, captured logs | **Copy the method** for the "server holds only references" and "no answer in logs" tests |
| `apps/server/src/storage-relay/hub.ts` (GWP-63, landed) | `ctx.services.storage.write({orgId, connectionId, folder, name, vars, ext?, contentType, size, source, signal?})` → `{ok:true, reference}` or `{ok:false, error:{code, message, retryable}}`; `not_found` / `invalid` / `too_large` / `unavailable` (in-flight cap) / `runner_offline` before anything is sent; 256 KiB chunks with credit window; checks the receipt's size, sha256 and connection id; nothing persisted | The **only** way content leaves the server in this card |
| `packages/shared/src/storage/index.ts` (GWP-63) | `StorageReferenceSchema`, `STORAGE_RETRYABLE`, `STORAGE_TEMPLATE_KEYS`, `renderStoragePath`, `STORAGE_MAX_FILE_BYTES` (25 MiB) | References stored as-is; retryable flag from `STORAGE_RETRYABLE` |
| `packages/shared/src/forms/*` (GWP-64) | `FormDefinitionSchema` (`schemaVersion`, `settings`, `fields`), `validateFormAnswers`, `validateFieldAnswer`, `FormFileAnswer`, `FORM_LIMITS`, `FORM_TEMPLATE_KEYS` | Shared validation for server, public page and builder preview |
| `apps/server/src/queries/forms.ts`, `commands/forms.ts` (GWP-64) | `getForm`, `getFormVersion`, `readFormLogo`, `logoContentType`; `forms.status` active/archived | Load the published version; serve the logo |
| `apps/web/src/components/forms/FormRenderer.tsx`, `pages/FormBuilderPage.tsx` (GWP-64) | Renderer with `mode: 'preview' | 'public'`, Build/Preview tabs | Public page reuses the renderer (extended, §4.5); publish panels go on the builder page |

## 3. Options compared and decisions

### 3.1 Public URL and where the public page lives

| | A. `/f/<publicId>` served by the app server, separate small Vite entry `form.html` (**recommended**) | B. Route inside the existing SPA (`index.html`) | C. Server-rendered HTML (like `/blog`) |
|---|---|---|---|
| Third-party / extension scripts | none: the entry imports only the form renderer | the hosted extension module and app shell load too | none |
| Shared validation and renderer with the builder preview (GWP-64 req. 5, 7) | yes (same React component and shared rules) | yes | no: a second renderer to keep identical |
| Strict CSP possible (no `'unsafe-inline'`) | yes, its own header | no: app CSP needs `style-src 'unsafe-inline'` | yes |
| Bundle on a phone over mobile data | small (form only) | the whole app | smallest |

**D1: A.** Public id = `randomToken(16)` (128 bits, 22 base64url chars, `^[A-Za-z0-9_-]{22}$`). URL =
`${publicOrigin}/f/<publicId>`. The QR code encodes exactly that string.

Same origin as the app (needed for the Origin CSRF check and `connect-src 'self'`). A separate forms origin (for
cookie isolation on the hosted service) is a GWP-69 option, not this card; the public API ignores session cookies
entirely, so nothing there depends on one.

### 3.2 Per-client link token

| | A. Opaque random token, hash in DB | B. JWT / PASETO with claims | C. HMAC-signed compact token over a link id + expiry, row for revocation (**recommended**) |
|---|---|---|---|
| Forged or expired token refused without a DB read | no | yes | yes |
| Revocation | row | needs a row anyway | row |
| Personal data in the token | none | tempting to put the client in claims | none: only a random link id and an expiry |
| New dependency | no | yes (or hand-rolled JWT) | no (`signingKey` exists) |

**D2: C.** Token = `v1.<linkId>.<exp>.<sig>`:
- `linkId`: 16 random bytes base64url (22 chars), the `form_client_links.id` stored as text (not a uuid, so it is not
  time-ordered and reveals nothing);
- `exp`: expiry, unix seconds, base36;
- `sig`: base64url HMAC-SHA256 with `signingKey(ctx, 'form-client-link')` over `v1|<formId>|<linkId>|<exp>` (binds the
  link to one form).

Verification order: format → signature (`timingSafeEqual`) → `exp > now` → row exists, same form, not revoked, not
used. The token travels in the URL **fragment**: `${publicOrigin}/f/<publicId>#c=<token>`. A fragment is never sent in
the request line, so it never reaches the server's access log, a proxy log or a `Referer`; the page reads it and sends it
in the `x-form-link` header. Rotating `AOM_SECRET_KEY` invalidates every client link (documented).

Lifetime: chosen per link, default 14 days, 1 to 90 days. A link is **consumed** by the first completed submission
(`used`); a failed or abandoned submission does not consume it. Journeys (GWP-66/67) issue a new link when they need a
second submission.

### 3.3 Submission file format (the text answers) (revised: default templates)

| | JSON only | HTML only (JSON embedded) | **JSON + readable HTML (recommended)** | JSON + PDF |
|---|---|---|---|---|
| Machine-readable for journeys/automations | yes | awkward | yes | yes |
| Readable by the desk by double-click | no | yes | yes | yes |
| Cost / risk | none | script-shaped data in a document | low: pure template, escaped | a PDF engine on the server (Playwright) or runner: heavy |

**D3: two files, one logical answers record.** `<name>.json` is the answers file (the record of truth) and
`<name>.html` a readable copy rendered from the same object. Both are built in memory on the server from the validated
answers and written through `storage.write` to `definition.settings.answersDestination` with `ext: 'html'` and
`ext: 'json'` (the relay appends the extension); nothing is kept. The HTML is static: no script, every value
HTML-escaped, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';
img-src data:">`, inline CSS only. Write order: HTML first, then JSON, so a present JSON file means a complete
submission on the firm's side too.

**PDF copy (GWP-142).** A third file, `<same base name>.pdf` in the same folder, is made on the runner from the HTML it
just received (the HTML write carries `derive: { pdf: true }`; the runner reports the PDF reference in `derived.pdf`).
The server never sees the PDF bytes. If it cannot be made the submission still completes and the desk gets one "PDF copy
missing" notice that points to the HTML copy. See docs/investigations/GWP-142-pdf-copy-of-a-form-s-answers.md.

JSON shape (`v: 1`):

```json
{
  "v": 1,
  "submission": { "id": "…", "submittedAt": "2026-11-03T09:12:44Z", "form": { "id": "…", "title": "…", "version": 3 } },
  "client": { "reference": "CL-1042", "linkId": "…" },
  "answers": [ { "id": "full_name", "label": "Full name", "type": "short_text", "value": "…" } ],
  "files":   [ { "id": "id_copy", "label": "ID copy", "name": "id.pdf", "size": 182233, "sha256": "…",
                 "contentType": "application/pdf", "stored": { "connectionId": "…", "path": "…", "providerId": "…" } } ]
}
```

`client` is `null` for the anonymous public URL. Answers and files carry the GWP-64 field `id`. Templates come from the
form (GWP-64 already sets defaults: answers folder `Forms/{form}`, name `{date}-{submission}`; file folder
`Forms/{form}/{submission}`, name `{field}-{original}`); this card adds no defaults of its own.

### 3.4 Bot protection

| | Third-party CAPTCHA (reCAPTCHA, hCaptcha, Turnstile) | Honeypot only | **Honeypot + minimum fill time + proof of work (recommended)** |
|---|---|---|---|
| Third-party script on the page | yes: breaks "no third-party scripts" and the CSP | no | no |
| Privacy (clients' IPs to a third party) | yes | no | no |
| Stops naive form spam | yes | mostly | yes |
| Cost to a scripted attacker | high | none once known | CPU per submission (~65 000 hashes) plus the rate limits |
| Accessibility | puzzles are a barrier | invisible | invisible (solved in a worker while the person types) |

**D4:** all three, no third party.
- Honeypot: one text input named `website`, inside a container that is visually hidden (class, not inline style),
  `tabindex="-1"`, `autocomplete="off"`, `aria-hidden="true"`. Non-empty → generic refusal (422 `submission_refused`,
  "We could not accept this submission. Please try again."). No fake success: a firm must never lose a real person's
  answers silently.
- Minimum fill time: the form session must be at least `AOM_FORMS_MIN_FILL_MS` (default 3000) old at start.
- Proof of work: the signed form session token is the challenge; the client finds `nonce` with
  `sha256(session + ':' + nonce)` having `AOM_FORMS_POW_BITS` (default 16, 0 disables, max 22) leading zero bits. A Web
  Worker (`worker-src 'self'`) starts solving when the page loads, so it is ready by the time the person submits. The
  session is single use (unique column, §4.1), so no in-memory "used" map is needed and it works across instances.

### 3.5 How the upload reaches the runner

Decided by GWP-63 (D1 there, landed as `StorageRelay`): streamed relay over the runner WebSocket, nothing persisted.
This card adds the public side:

| | One multipart POST with answers and all files | **Start → one raw PUT per file → complete (recommended)** |
|---|---|---|
| Streaming without a multipart parser buffering parts | needs careful busboy use | trivial: the request body is the file |
| Size limit per file enforced before reading | only per part, mid-stream | `Content-Length` checked against the manifest before the first byte is read |
| Retry after a storage failure | re-upload everything | only the files that did not land; answers re-sent with complete |
| Progress per file on a phone | no | yes |

**D5: three steps** (§4.3). The browser keeps the answers and the `File` objects in memory, so retry never needs
retyping. Files are uploaded one at a time (bounded server memory: one GWP-63 window per active upload).

### 3.6 Virus scanning

**D6: out of scope; recorded as a follow-up.** The server never stores or serves an upload, and files land only in the
firm's storage, so the scanner belongs on the runner (for example clamd on the workstation, before `connector.put`).
Mitigations in this card: allowlist per field, magic-byte check, executables refused by extension **and** by content,
macro-enabled Office formats not accepted (`docm`, `xlsm`, `pptm` are not in `FORM_UPLOAD_TYPES`), the readable HTML
never embeds an upload. A backlog suggestion is filed: "Runner-side malware scan of form uploads (clamd), with a
quarantine folder".

## 4. Design

### 4.1 Data model (server; migration `apps/server/migrations/2830_public_forms.sql`, next free number at build time)

```sql
-- projection of FormPublished / FormUnpublished / FormPublicLinkReset (org metadata, event sourced)
CREATE TABLE IF NOT EXISTS form_publications (
  form_id uuid PRIMARY KEY,                 -- GWP-64 forms(id)
  org_id uuid NOT NULL REFERENCES organizations(id),
  public_id text NOT NULL UNIQUE,           -- 22 chars base64url, 128 bits
  version int NOT NULL,                     -- the published form version (form_versions.version)
  status text NOT NULL,                     -- published | unpublished
  published_at timestamptz NOT NULL, published_by uuid NOT NULL,
  unpublished_at timestamptz
);

-- projection of FormClientLinkCreated / FormClientLinkRevoked / FormClientLinkUsed
CREATE TABLE IF NOT EXISTS form_client_links (
  id text PRIMARY KEY,                      -- 22 chars base64url (the link id in the token)
  org_id uuid NOT NULL REFERENCES organizations(id),
  form_id uuid NOT NULL,
  reference text NOT NULL,                  -- the firm's client/record reference, max 120 (UI: "a client number, not a name")
  record_kind text, record_id text,         -- optional journey record ref (GWP-66/67), opaque
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL,
  revoked_at timestamptz, revoked_by uuid,
  used_at timestamptz, used_by_submission uuid
);
CREATE INDEX IF NOT EXISTS form_client_links_form ON form_client_links(form_id);

-- operational (not event sourced), kept over rebuild; the ONLY row a submission leaves
CREATE TABLE IF NOT EXISTS form_submissions (
  id uuid PRIMARY KEY,                      -- uuidv7
  org_id uuid NOT NULL, form_id uuid NOT NULL, form_version int NOT NULL,
  link_id text,                             -- client/record reference via the link (NULL = public URL)
  status text NOT NULL,                     -- receiving | storing | failed | complete | expired
  error_code text,                          -- a StorageErrorCode or our own code, never a message with values
  session_nonce text NOT NULL UNIQUE,       -- anti-replay (the nonce part of the session token)
  parts jsonb NOT NULL,                     -- [{ field, index, size, sha256, ext, state: pending|stored|failed, reference? }]
  answers_refs jsonb NOT NULL DEFAULT '{}', -- { html?: StorageReference, json?: StorageReference }
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  completed_at timestamptz, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS form_submissions_form ON form_submissions(form_id, created_at DESC);
```

- `form_submissions` goes in `SAVED` (`apps/server/src/projections/rebuild.ts`) with
  `restoreWhere: 'org_id IN (SELECT id FROM organizations)'`.
- `parts[].field` is the GWP-64 field `id`; `index` is always 0 today (one file per file field in GWP-64) and stays in
  the manifest for a later `multiple`. `reference` is a GWP-63 `StorageReference` as returned (schema checked by the
  relay).
- What `parts` holds: field id, part index, declared size, sha256, sniffed extension and the GWP-63 reference. No answer
  values, no file content, no IP, no user agent. The `reference.path` may contain the client's original file name when
  the firm's template uses `{original}` (the GWP-64 default does); that is a storage reference, which the card allows.
- Pruning (existing job loop): rows `receiving`/`failed` past `expires_at` become `expired`; `expired` rows older than
  30 days are deleted. `complete` rows stay (they are the desk's submission list).

Events (add to `packages/shared/src/events/form.ts`, next to `FormVersionSaved`/`FormArchived`, stream
`streamId.form(formId)`; projection `apps/server/src/projections/public-forms.ts` registered next to
`projections/forms.ts`):
- `FormPublished { formId, orgId, publicId, version, by }` (also "publish changes": same public id, new version)
- `FormUnpublished { formId, orgId, by }`
- `FormPublicLinkReset { formId, orgId, publicId, by }` (new id: old URL and QR stop working)
- `FormClientLinkCreated { linkId, formId, orgId, reference, recordKind?, recordId?, expiresAt, by }`
- `FormClientLinkRevoked { linkId, formId, orgId, by }`, `FormClientLinkUsed { linkId, formId, orgId, submissionId }`
- `FormSubmitted { submissionId, formId, orgId, version, linkId?, answers: StorageReference, files: StorageReference[] }`
  (references only; GWP-66/67 subscribe to this for "form submitted" triggers).

### 4.2 Shared (`packages/shared/src/forms/public.ts`, exported from `forms/index.ts`) (revised)

```ts
export const PUBLIC_FORM_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const CLIENT_LINK_TOKEN_RE = /^v1\.[A-Za-z0-9_-]{22}\.[0-9a-z]{1,8}\.[A-Za-z0-9_-]{43}$/;

/**
 * What the public may see: the GWP-64 FormDefinition with every `destination` and `settings.answersDestination`
 * removed and `settings.logo` reduced to `{ alt }` (the URL is the public logo route). No connection id, folder or
 * name template.
 */
export function publicFormView(def: FormDefinition): PublicFormView;
export const PublicFormViewSchema = …;   // FormDefinitionSchema minus destinations; parse() on the page

/** Upload types a file field may accept; content type is ours, never the browser's. */
export const FORM_UPLOAD_TYPES: Record<string, { contentType: string; group: 'image'|'document'|'sheet'|'text'|'archive' }>;
//  pdf, png, jpg, jpeg, gif, webp, heic, heif, docx, xlsx, pptx, odt, ods, txt, csv, zip   (no svg, no macro formats)

/**
 * Extensions a field accepts: the GWP-64 `allowedTypes` entries are `.ext` or MIME patterns (`image/png`, `image/*`).
 * `.ext` counts when it is in FORM_UPLOAD_TYPES; a MIME entry expands to every FORM_UPLOAD_TYPES extension whose
 * contentType matches it. Anything else (e.g. `.exe`, `.docm`, `image/svg+xml`) is dropped.
 */
export function acceptedUploadExtensions(allowedTypes: readonly string[]): string[];

/** Checks the first bytes (≥ 4100 or the whole file) against the extension and the field's accepted extensions. */
export function checkUploadHead(ext: string, head: Uint8Array, accepted: readonly string[]):
  { ok: true; contentType: string } | { ok: false; code: 'type_not_allowed'|'executable'|'content_mismatch'|'empty' };
export function sanitiseUploadName(raw: string): { base: string; ext: string };   // safeAttachmentName + lower-case ext

/**
 * Server-side answer check: the GWP-64 validator with our content type for files (never the browser's `type`),
 * strict mode (unknown answer keys refused), and only field id + code returned (no message, no value).
 */
export function checkPublicAnswers(def: FormDefinition, answers: Record<string, unknown>,
  files: Array<{ field: string; index: number; name: string; size: number; sha256: string }>):
  { ok: true } | { ok: false; errors: Array<{ field: string; code: FormFieldErrorCode | 'unknown_field' | 'file_missing' | 'file_not_expected' }> };

export const SubmissionStartSchema, SubmissionStartResultSchema, PartResultSchema, CompleteSchema, … // §4.3
export const PUBLIC_FORM_ERROR_CODES = ['form_not_available','link_invalid','link_expired','link_revoked','link_used',
  'session_invalid','session_used','form_changed','submission_refused','invalid_answers','file_too_large',
  'file_type_refused','too_many_files','parts_missing','submission_expired','storage_failed','runner_offline',
  'destination_missing','rate_limited'] as const;
```

`checkPublicAnswers` (the thin wrapper over the landed validator):
1. Text answers: only non-file fields may appear in `answers`; any file-field key in `answers` is ignored and rebuilt
   from the manifest.
2. For each manifest entry: the field exists and is `type: 'file'` (else `file_not_expected`); build
   `FormFileAnswer { name, size, type: FORM_UPLOAD_TYPES[ext].contentType ?? '' }` from the sanitised name, so a MIME
   rule in `allowedTypes` is checked against **our** type. A manifest extension not in `acceptedUploadExtensions(field
   .allowedTypes)` → `file_type`.
3. `validateFormAnswers(def, merged, { strict: true })` → map `errors` to `[{ field: id, code }]` and `unknown` to
   `{ field, code: 'unknown_field' }`. The `message` from the shared validator is dropped on the server (the page
   computes the same message locally from the code-producing rule, because it runs the same validator).

The public page, the server and the builder preview all run `validateFormAnswers` (the page through the renderer, the
server through `checkPublicAnswers`), so the rules stay the same.

`checkUploadHead` reuses `executableMagic` and `magicMatches` from `attachments/index.ts` (export them; behaviour
unchanged) and adds `heic/heif` (`ftyp` at offset 4 with brand `heic|heix|mif1|heif`), `odt/ods` (zip), `csv/txt`
(no NUL in the head, valid UTF-8 start). Executables (by extension list or content) are always refused, whatever the
field allows.

### 4.3 Public API (`apps/server/src/public-forms/routes.ts`, registered in `app.ts` next to `relayPublicRoutes`) (revised: field names, destination check)

All routes: registered without fastify-plugin, `logLevel: 'silent'`, own error handler (status + `{error:{code,message}}`,
never `details`, never an echo of the input, never `reportServerError` with request data), no session cookie read, the
public id looked up in `onRequest` before the body is read, rate limits in `preHandler`. Unknown public id, unpublished
form, **archived form** (`forms.status='archived'`) and a non-operational organization all give the **same** 404
`form_not_available` (same body; no enumeration).

The published definition is read with `getFormVersion(ctx, orgId, formId, publication.version)` (GWP-64 query)
and cached in process by `(formId, version)` (versions are immutable).

| Method and path | Body | Answer |
|---|---|---|
| `GET /f/:publicId` | — | `form.html` with the public headers (§4.5). 404 status with the same HTML when not available (the page then shows "This form is not available"). |
| `GET /api/public/forms/:publicId` | header `x-form-link` optional | `{ form: PublicFormView, version, logo: url|null, session, powBits, link: null | { state: 'valid', expiresAt } }`. Link errors: 410 `link_expired` / `link_revoked` / `link_used`, 404 `link_invalid` (bad format or signature, or another form's link). |
| `GET /api/public/forms/:publicId/logo` | — | `readFormLogo(ctx, orgId, settings.logo.imageId)` of the **published** version; content type re-checked with `logoContentType`; `cache-control: public, max-age=300`, `content-security-policy: sandbox; default-src 'none'`, `nosniff`. 404 when none. |
| `POST /api/public/forms/:publicId/submissions` | `{ session, nonce, website, link?, answers, files: [{ field, index, name, size, sha256 }] }` | 201 `{ submissionId, uploadToken, parts: [{ field, index, needed }] }` |
| `PUT /api/public/forms/:publicId/submissions/:sid/parts/:index` | raw file bytes, `content-type: application/octet-stream`, `content-length` required, header `x-upload-token` | 200 `{ state: 'stored' }` or an error with `retryable` |
| `GET /api/public/forms/:publicId/submissions/:sid` | header `x-upload-token` | `{ status, parts: [{ field, index, state }] }` (for resuming a retry) |
| `POST /api/public/forms/:publicId/submissions/:sid/complete` | `{ answers }`, header `x-upload-token` | 200 `{ status: 'complete', confirmation }` or an error with `retryable` |

`:index` in the part path is the position in the manifest (0-based), not the field's own index.

**Start** (`POST …/submissions`), in order:
1. Rate limits (§4.4). 2. Form published, not archived, organization operational. 3. Session token: signature, not
   older than `AOM_FORMS_SESSION_TTL_MIN` (default 240), not younger than the minimum fill time, version equals the
   published version (else 409 `form_changed`: the page reloads the definition and keeps the answers by field id).
   4. Honeypot empty. 5. Proof of work. 6. Client link (if any) valid and of this form. 7. `checkPublicAnswers` on the
   answers and the file manifest, plus: `size ≤ min(field.maxSizeBytes, ctx.config.storage.maxFileBytes)`, at most
   `AOM_FORMS_MAX_FILES` (default 20) files and `AOM_FORMS_MAX_SUBMISSION_BYTES` (default 100 MiB) in total, sha256 is
   64 hex. Errors: 400 `invalid_answers` with `[{ field, code }]` (rule codes, never values), 413 `file_too_large`,
   415 `file_type_refused`. 8. **Destinations and runner presence**: collect `settings.answersDestination.connectionId`
   and the `destination.connectionId` of every file field that has a file in the manifest; any `null`, or any id not
   found as an active `storage_connections` row of the org → 409 `destination_missing` (non-retryable, "This form
   can't accept submissions. Please contact <firm>."; publish already refuses this, §4.7, but a connection can be
   removed later). Any workstation with `ctx.services.runners.isOnline(workstation_id) === false` → the runner-offline
   hook (§4.6); default answer 503 `runner_offline` with `Retry-After`. 9. Insert the `form_submissions` row
   (`receiving`, parts `pending`, `session_nonce` from the token: a second use is 409 `session_used`, the page fetches a
   fresh session and starts again, answers kept). 10. Return the upload token: `u1.<submissionId>.<exp>.<sig>` with
   `signingKey(ctx, 'form-upload')`, valid until the row's `expires_at` (`AOM_FORMS_SUBMISSION_TTL_MIN`, default 120).

The text answers are validated here only to fail fast; **they are not kept**. The browser sends them again with
complete.

**Part** (`PUT …/parts/:index`):
1. Rate limit, upload token (bound to `sid`), row in `receiving` or `failed`, part exists and is not `stored`.
2. `content-length` required (411 otherwise) and equal to the manifest size (400 `invalid_answers` otherwise);
   `transfer-encoding: chunked` without a length is refused. These checks happen **before the body is read**; on refusal
   the reply carries `connection: close` so a 25 MiB body is not drained.
3. Content parser for this route only: `application/octet-stream` → pass the raw stream on (`done(null, payload)`), no
   buffering. Read the head (first 4100 bytes or the whole file if smaller), run `checkUploadHead(ext, head,
   acceptedUploadExtensions(field.allowedTypes))` → 415 `file_type_refused` (part `failed`, code `file_type_refused`,
   not retryable).
4. `ctx.services.storage.write({ orgId, connectionId: field.destination.connectionId, folder: field.destination.folder,
   name: field.destination.name, vars, ext, contentType, size, source: concat(head, rest of req.raw), signal })`, where
   `signal` aborts when the client disconnects. `vars` always holds **all nine** `STORAGE_TEMPLATE_KEYS` (a missing key
   is a render error in GWP-63): `form` (title), `field` (field id), `submission` (first 8 chars of the id), `client`
   (link reference or `public`), `journey` (record id or `''`), `original` (sanitised base name), `ext`, `date`/`time`
   (server fills from the start time in the org's time zone). A byte counter wraps the source: more bytes than
   declared → stop reading, 413 (the relay also refuses with `too_large`).
5. The reference's sha256 must equal the manifest's (the relay already checks it against the bytes it sent; a mismatch
   with the manifest → part `failed`, 400 `invalid_answers`, not retryable).
6. `ok` → part `stored` with the reference. Error → part `failed`, `error_code` = the storage code, response
   `502 storage_failed` with `{ retryable: STORAGE_RETRYABLE[code] }`, or 503 `runner_offline` (then the hook, §4.6).
   `not_found` (connection removed meanwhile) → 409 `destination_missing`.

**Complete** (`POST …/complete`):
1. Upload token; row `receiving` or `failed`; every part `stored` (else 409 `parts_missing` with the list).
2. `checkPublicAnswers` again (the answers body is the same object the page sent at start; the manifest is rebuilt from
   `parts`).
3. Claim: `UPDATE form_submissions SET status='storing' … WHERE id=$1 AND status IN ('receiving','failed') RETURNING`
   (one complete at a time; a concurrent second call gets 409 and polls status).
4. Build the JSON and HTML in memory (§3.3) with the parts' references; write HTML, then JSON, through
   `storage.write` to `settings.answersDestination` (`source` = the buffer as a one-item iterable), skipping a document
   whose reference is already in `answers_refs`.
5. Both written → one transaction: `status='complete'`, `completed_at`, `answers_refs`; `FormClientLinkUsed` and
   `FormSubmitted` events. Response `{ status: 'complete', confirmation: settings.confirmationText }`.
6. Any failure → `status='failed'`, `error_code`, response 502 `storage_failed` (`retryable`) or 503 `runner_offline`.
   **Nothing is marked complete unless both writes returned a reference.**
7. Complete on a `complete` row → 200 with the same answer, no new write (idempotent).

Retry (browser): on `storage_failed` with `retryable`, the page shows "We couldn't save your form to <firm>'s storage.
Your answers are still here. Try again." and a **Try again** button; it calls `GET …/:sid` and re-sends only the parts
not `stored`, then complete. If the submission expired (410 `submission_expired`) or the session was used, it starts a
new submission silently with the kept answers and files. A non-retryable code shows the reason and the firm's name
("Please contact <firm>").

Orphans: a retry after a partly failed run may leave uploads on the firm's storage without a JSON (expired
submissions). GWP-63 offers no delete through the relay; a follow-up (`storage.delete` for cleanup of expired
submissions) is filed as a backlog suggestion. The desk can see expired submissions in the list.

### 4.4 Rate limiting (`apps/server/src/public-forms/limits.ts`)

`KeyedBuckets` class (bucket maths from `RelayHub.takeToken`, Map bounded at 50 000 keys with sweep of full buckets),
always on (like the relay: not switched off by `AOM_RATE_LIMIT=false`), per process. Keys: `ip:<HMAC(ip)>` (the
`ipHash` approach; the IP is never stored or logged) and `form:<formId>`.

| Bucket | Default | Env |
|---|---|---|
| All public form requests per IP | 120/min, burst 60 | `AOM_FORMS_IP_PER_MIN`, `AOM_FORMS_IP_BURST` |
| Submission starts per IP | 10/hour, burst 5 | `AOM_FORMS_IP_SUBMITS_PER_HOUR`, `AOM_FORMS_IP_SUBMIT_BURST` |
| Submission starts per form | 60/min, burst 30 | `AOM_FORMS_FORM_SUBMITS_PER_MIN`, `AOM_FORMS_FORM_SUBMIT_BURST` |

Over a limit → 429 `rate_limited` with `Retry-After`; the page says "Too many attempts. Please wait a minute and try
again." Config in `apps/server/src/config.ts` under `publicForms`, with the other new variables:
`AOM_FORMS_POW_BITS` (16, 0..22), `AOM_FORMS_MIN_FILL_MS` (3000), `AOM_FORMS_SESSION_TTL_MIN` (240),
`AOM_FORMS_SUBMISSION_TTL_MIN` (120), `AOM_FORMS_MAX_FILES` (20), `AOM_FORMS_MAX_SUBMISSION_BYTES` (100 MiB). The per-file
cap is the existing `ctx.config.storage.maxFileBytes` (GWP-63) together with the field's `maxSizeBytes`.

Note for the security review: `trustProxy: true` (`app.ts`) trusts any `X-Forwarded-For`, so a server reachable without
a proxy lets a client choose its IP and dodge the per-IP bucket (the per-form bucket still holds). Self-hosting docs
must say "run behind a proxy"; a configurable hop count is a backlog suggestion (it changes existing behaviour, so not
in this card). GWP-69 sets it for the hosted service.

### 4.5 Public page (web) (revised: renderer API)

| File | Content |
|---|---|
| `apps/web/form.html` | Minimal document: `<div id="root">`, one module script `/src/public-form/main.tsx`, `<meta name="robots" content="noindex,nofollow">`, `<meta name="referrer" content="no-referrer">`, no `theme-init.js`, no manifest, no service worker registration |
| `apps/web/vite.config.ts` | `rollupOptions.input` gets `form: resolve(webRoot, 'form.html')`; a dev-only plugin rewrites `/f/*` to `/form.html` |
| `apps/web/src/public-form/main.tsx`, `PublicFormPage.tsx` | Reads `publicId` from the path and `#c=` from the fragment (then `history.replaceState` to drop the fragment from the address bar), fetches the definition, renders GWP-64's `FormRenderer` in `mode="public"` with the props below, honeypot, the PoW worker, the start → parts → complete flow with per-file progress, retry and the states below |
| `apps/web/src/public-form/pow.worker.ts` | `crypto.subtle.digest('SHA-256')` loop; posts the nonce |
| `apps/web/src/public-form/api.ts` | `fetch` without credentials (`credentials: 'omit'`), JSON for start/complete, `PUT` of the `File` object (the browser sets `content-length`) |
| `apps/web/src/public-form/messages.ts` | Pure: error code → sentence (tested) |

**Renderer changes (`apps/web/src/components/forms/FormRenderer.tsx`, additive; preview behaviour unchanged).** The
landed renderer keeps answers in its own state, calls a synchronous `onSubmit(answers)` and immediately shows its
"done" screen, and keeps only `{name, size, type}` for a file. It needs no provider and uses classes only, so the strict
CSP stands. Add optional props, all ignored in `mode="preview"`:

```ts
initialAnswers?: Record<string, FormAnswerValue>;          // restore after reload / form_changed (text only)
onAnswersChange?: (answers: Record<string, FormAnswerValue>) => void;   // sessionStorage mirror
onFileChange?: (fieldId: string, file: File | null) => void;            // the page keeps the File objects
onSubmit?: (answers) => void | Promise<void>;              // public: the renderer does NOT set done itself
done?: boolean;                                            // public: the page decides when the confirmation shows
busy?: boolean;                                            // disables submit, shows progress text from `status`
status?: ReactNode;                                        // progress / retry / error block above the submit button
serverErrors?: Record<string, FormFieldErrorCode>;         // codes from 400 invalid_answers, shown with the shared message
extra?: ReactNode;                                         // slot for the honeypot container inside the <form>
```

In `mode="public"`: `done` is controlled by the prop (default false), `submit` validates as today and then awaits
`onSubmit`; a file input that is restored from `initialAnswers` shows "Choose this file again" (a `File` cannot be
restored). `serverErrors` map to the message by re-running `validateFieldAnswer` locally, or a generic sentence per code
when it does not reproduce. The existing `apps/web/src/test/form-renderer.test.tsx` must pass unchanged (name it in the
handoff if it needs a touch).

Bundle check: `FormRenderer` imports `Button` and `inputCls` from `components/ui.tsx`, which imports `react-router`,
Radix Dialog and `lib/terms.ts` (→ `api/queries/auth.ts`, `ws/socket.ts`). None of them run side effects on import or
need a provider for `Button`, so the page works without the app shell; rollup drops most of it. The builder adds a
test that the built `form` chunk graph does not include `ws/socket` or the extension loader (or, simpler and enough:
`form-html.test.ts` asserts the entry imports nothing from `src/extension*`/`src/app*`). If the chunk is still large,
moving `Button`/`inputCls` into `components/ui/` primitives is allowed as a follow-up, not required here.

Page states: loading; **form**; submitting (file *n* of *m*, progress); **done** (confirmation text); **not available**
("This form is not available. It may have been closed by <firm>." – firm name only when the form is published, else
just "This form is not available."); **link expired / revoked / used** ("This personal link has expired. Ask <firm> for
a new one." / "…is no longer valid…" / "…was already used to send this form."); **storage failed** (retry);
**cannot accept** (`destination_missing`: "This form can't accept submissions. Please contact <firm>.");
**temporarily unavailable** (runner offline default: "This form can't accept submissions right now. Please try again
later." with the answers kept and a Try again button); **too many attempts**.

All devices including touch (standing order). The landed renderer already covers part of it: one column `max-w-xl`,
`text-base` inputs (16 px, no iOS zoom), `min-h-11` on coarse pointers, `type=email`/`tel`, `inputMode: 'decimal'` for
numbers, `autoComplete` email/tel, `accept` on file inputs and no forced `capture`. The public page adds: a focused
field is scrolled into view when the soft keyboard opens (`visualViewport` resize → `scrollIntoView({block:'center'})`);
the submit button is not fixed over the inputs while the keyboard is open; the error summary (`role="alert"`, already
in the renderer) gets focus. Text answers are mirrored into `sessionStorage` (key `gwf:<publicId>`, never
`localStorage`) through `onAnswersChange`, so an Android tab killed while the camera app is open comes back with the
answers; cleared on complete and on "Start over". Files cannot be restored that way; the page says which to choose again.

Headers for `GET /f/:publicId` (set in the route, so the global hook does not overwrite them):

```
content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:;
  connect-src 'self'; worker-src 'self'; font-src 'self'; form-action 'none'; base-uri 'none';
  frame-ancestors 'none'; object-src 'none'; manifest-src 'none'[; upgrade-insecure-requests]
cache-control: no-store
x-robots-tag: noindex, nofollow
referrer-policy: no-referrer
cross-origin-resource-policy: same-origin
```
(plus the existing `nosniff`, `x-frame-options: DENY`, COOP, HSTS from the global hook). No `'unsafe-inline'`: checked
on the landed renderer, it has no `style` attribute; the public page must keep it that way (the honeypot is hidden with
a class). If a later change needs style attributes, `style-src-attr 'unsafe-inline'` is the only allowed relaxation and
the CSP test must pin exactly that.

### 4.6 Runner-offline hook (for GWP-68)

`apps/server/src/public-forms/offline-hook.ts`:

```ts
export interface RunnerOfflineHook {
  /** Called when a submission cannot land because a destination's workstation is offline. Never given answers. */
  onRunnerOffline(ctx: Ctx, e: { orgId: string; formId: string; formVersion: number; linkId: string | null;
    submissionId: string | null; stage: 'start' | 'part' | 'complete'; connectionIds: string[] }):
    Promise<{ kind: 'unavailable' } | { kind: 'link_later'; message: string; status?: 202 }>;
}
export const defaultRunnerOfflineHook: RunnerOfflineHook = { onRunnerOffline: async () => ({ kind: 'unavailable' }) };
```

`ctx.services.publicFormsOffline` holds it (default above). The routes call it on every `runner_offline` (start,
part, complete) and map `unavailable` to 503 `runner_offline` + `Retry-After: AOM_RELAY_RETRY_AFTER_SEC` and
`link_later` to the hook's status and message (`{ status: 'link_later', message }`, the page shows it as the final
state). A submission in `receiving`/`failed` is not marked complete either way. GWP-68 replaces the default and decides
how the e-mail address is asked for (that card owns any extra field).

### 4.7 Authoring side (server routes and web) (revised: guard, destination check, placement)

`apps/server/src/commands/public-forms.ts` (commands + queries) and `apps/server/src/routes/public-forms-admin.ts`.
Guard: the same as GWP-64's form routes: `requireOrg(ctx, req)` for reads, `requireOrg(ctx, req, { min: 'admin' })`
for every write. Paths sit under GWP-64's `/api/forms/:id` (not `/api/org/forms`).

| Method and path | Purpose |
|---|---|
| `GET /api/forms/:id/publication` | `{ status, url, publicId, version, latestVersion, publishedAt, warnings: [...] }`; warnings: `destination_missing` (connection null, removed), `destination_offline` (workstation offline), `unsupported_file_types` (an `allowedTypes` entry that `acceptedUploadExtensions` drops, e.g. `.exe` or `.docm`), `connection_unhealthy` (GWP-63 health not `connected`) |
| `POST /api/forms/:id/publish` | publish `forms.latest_version` (also "Publish changes"); 409 `destination_missing` with the field ids whose `destination.connectionId` is null or not an active connection (and `answers` for `settings.answersDestination`); 409 `form_archived` for an archived form; a file field whose accepted extensions are empty → 409 `unsupported_file_types` |
| `POST /api/forms/:id/unpublish` | URL then shows "form not available" |
| `POST /api/forms/:id/publication/reset-link` | new public id (confirm dialog: printed QR codes stop working) |
| `GET /api/forms/:id/client-links` | list: reference, state (active/expired/revoked/used), expiresAt, url (re-derived from the row: the token is deterministic) |
| `POST /api/forms/:id/client-links` `{ reference, expiresInDays?, recordKind?, recordId? }` | 201 `{ id, url, expiresAt }`; also exported as `createClientLink(ctx, who, …)` for journey steps |
| `POST /api/forms/:id/client-links/:linkId/revoke` | revoke |
| `GET /api/forms/:id/submissions?cursor` | metadata: status, timestamps, version, reference, storage references (for the desk) |

Archiving a published form (GWP-64 `archiveForm`) leaves the publication row; the public routes treat an archived form
as not available, and the panel shows "Archived: the public link is closed". No change to `archiveForm`.

Web (on GWP-64's `apps/web/src/pages/FormBuilderPage.tsx`, which has Build/Preview tabs): add a third tab **Share**
(`tab-share`) holding the two panels below, and a status badge next to the title.
- `apps/web/src/components/forms/PublishPanel.tsx`: status badge, Publish / Publish changes (when `latestVersion >
  version`; every GWP-64 save is a new version) / Unpublish / Reset link (confirm), the warnings, the URL with **Copy**,
  the QR code (`QrCode` with `value` = the URL exactly) and **Download PNG** / **Download SVG**.
- `apps/web/src/lib/qr.ts`: `qrMatrix(value)`, `qrSvg(value)` (the string the component and the SVG download share),
  `qrPng(value, scale)` (canvas). `QrCode.tsx` switches to `qrMatrix` (render unchanged; covered by the existing
  two-factor test).
- `apps/web/src/components/forms/ClientLinksPanel.tsx`: create (reference, expiry select 7/14/30/90 days), copy, show
  QR, revoke (confirm), state badges. Touch: actions in a menu on narrow screens, buttons ≥ 44 px, the create dialog
  scrolls inside the viewport when the keyboard opens.
- `apps/web/src/components/forms/SubmissionsList.tsx`: status, time, reference, "Open in storage" text (the path; no
  link to Guildwise content because there is none).
- `apps/web/src/api/queries/public-forms.ts` (next to `api/queries/forms.ts`); `apps/web/src/ws/invalidate.ts` case for
  the new events.

### 4.8 Logging and redaction

- `redactUrl` (`app.ts`): `/f/<id>` → `/f/[redacted]`, `/api/public/forms/<id>…` → `/api/public/forms/[redacted]…`
  (the public id is a capability to an organization's form).
- `LOG_REDACT`: add `req.body.answers`, `*.answers`, `body.answers`, `*.website`, `*.x-form-link`, `*.x-upload-token`.
- The public routes are `logLevel: 'silent'`; one line per outcome:
  `{ publicForm: { op: 'view'|'start'|'part'|'complete', formId, submissionId, status, outcome, sizeBytes, ms } }`.
  No IP, no user agent, no file name, no answer, no token. The GWP-63 relay adds its own
  `{ storage: { connectionId, kind, sizeBytes, outcome, latencyMs } }` line (no path or name), which is fine.
- The scoped error handler logs `{ publicForm: { op, status, errName } }` only.

### 4.9 Docs and changelog

- `docs/security/public-forms.md`: the threat model and controls of §6 (as built), referenced from
  `docs/ARCHITECTURE.md` and `SECURITY.md`.
- `docs/ARCHITECTURE.md`: section "Public forms" (routes, tokens, the three-step submission, what is kept).
- `docs/SELF-HOSTING.md`: the new `AOM_FORMS_*` variables; "run behind a reverse proxy" for the per-IP limits; set
  `AOM_SECRET_KEY` (rotating it invalidates client links).
- `CHANGELOG.md`: the `## [1.5.0]` heading already exists; add an **Added** entry for public forms under it:
  publish/unpublish with a public URL and QR code, per-client links, submissions written to the firm's storage through
  the runner with only references kept, retry, the security controls, migration number, the new variables.

## 5. Acceptance criteria → design → tests

All tests in **new** files. Unit suites (shared, web, runner) run in the build shift; server tests that need Postgres run
where the test DB is up (otherwise the builder says so and the tester runs them). E2E (`e2e/**`) is the tester's. The
web tests live in `apps/web/src/test/` (where GWP-64's tests are).

| AC | Design | Tests |
|---|---|---|
| 1. Publish gives URL + QR; scanning opens exactly that URL; unpublish → "form not available" | §3.1, §4.1 publications, §4.3 `GET /f`, §4.7 | `apps/server/test/public-forms-publish.test.ts`: publish → url = `${publicOrigin}/f/<22 chars>`; `GET /f/:id` 200 HTML; `GET /api/public/forms/:id` 200; unpublish → both 404 `form_not_available`, same body as an unknown id, an archived form and a suspended org; reset-link → old id 404; publish with a null destination → 409 `destination_missing`. `apps/web/src/test/qr.test.ts`: `qrMatrix(url)` decoded with `jsqr` (new **dev** dependency of apps/web) equals the URL byte for byte, including a long URL with `#c=` token; `publish-panel.test.tsx`: the QR `value` and the Copy text are the API url, Unpublish asks and calls the route. |
| 2. Per-client link opens the form for that client; expired/revoked refused clearly | §3.2, §4.1 links, §4.3 GET | `apps/server/test/form-client-link-token.test.ts` (unit, no DB: sign/verify, wrong form, flipped byte, expired by fake clock, malformed); `public-forms-links.test.ts`: create → GET with `x-form-link` → `link.state = valid`; revoked → 410 `link_revoked`; expired → 410 `link_expired`; used → 410 `link_used`; the token contains no reference text (assert the reference string is not in the token, base64-decoded either); `apps/web/src/test/public-form-page.test.tsx`: each link state shows its sentence. |
| 3. Valid submission writes the answers file and every upload to the destination through the runner; the row holds only status, timestamps, references | §3.3, §4.3, GWP-63 relay | `apps/server/test/public-forms-submit.test.ts`: a fake runner in a new helper file that answers the GWP-63 frames (`storage.write.open` → credit, `chunk` → credit, `end` → result with a `StorageReference` whose size/sha256 match the bytes; see `apps/server/test/storage-relay.test.ts` for the frame shapes) and writes to a temp dir as a local connection; submit 2 files + answers with sentinel values → files and `*.json` + `*.html` land in the temp dir at the templated paths; JSON parses and holds the references; then the **table dump** (method of `relay-no-content.test.ts`) contains no answer sentinel and no file-content sentinel, and the `form_submissions` row has only the listed columns, `status='complete'`, references present. `apps/server/test/public-forms-answers-doc.test.ts`: JSON shape; HTML escapes `<script>`, `"`, `&`; HTML has the meta CSP and no `<script`. |
| 4. Disallowed type (incl. renamed .exe), oversize, invalid fields rejected server-side even with browser checks bypassed | §4.2 `checkUploadHead`, `acceptedUploadExtensions`, `checkPublicAnswers`, §4.3 start/part checks | `packages/shared/test/form-upload-types.test.ts` (each type's magic; `MZ` bytes named `.pdf` → `executable`; `.exe` → refused; HEIC brands; text with NUL; empty; `acceptedUploadExtensions(['image/*'])` has png/jpg/gif/webp/heic but not svg; `['.exe','.docm']` → empty); `packages/shared/test/form-public-answers.test.ts` (`checkPublicAnswers`: browser `type` ignored, an `image/png` rule refuses a `.pdf`, unknown key → `unknown_field`, no message or value in the result); `apps/server/test/public-forms-negative.test.ts` (direct `inject`, no browser): missing required field → 400 `invalid_answers` with field + code only; manifest size over `maxSizeBytes` → 413; `.exe` in the manifest → 415; PUT of `MZ…` bytes for a `.pdf` part → 415 and nothing reaches the fake runner; content-length ≠ manifest → 400; body longer than declared → 413 and the relay aborted; replayed session → 409 `session_used`; expired session → 400 `session_invalid`; honeypot filled → 422; bad PoW → 422; upload token of another submission → 404. |
| 5. Storage write fails → retry message, retry without retyping, nothing marked complete | §4.3 part/complete failure, retry | `public-forms-submit.test.ts` (failure block): fake runner answers `unavailable` for the JSON write → 502 `storage_failed`, `retryable: true`, row `failed`, no `FormSubmitted` event, link not used; second complete after the runner recovers → `complete`, HTML not written twice (one HTML file in the dir); part failure → only that part needed on retry. `public-form-page.test.tsx`: 502 → retry message, answers still in the inputs, Try again sends only the missing part and complete. `form-renderer-public.test.tsx`: the new props (controlled `done`, `initialAnswers`, `onFileChange` gets the `File`, `serverErrors`), and preview mode unchanged. |
| 6. Rate limiting returns 429 after the threshold per IP and per form | §4.4 | `apps/server/test/public-forms-limits.test.ts` with small env values: same `x-forwarded-for` over two forms → 429 + `Retry-After` after the IP threshold; many IPs on one form → 429 after the form threshold; another form still accepted; unit test of `KeyedBuckets` refill with a fake clock. |
| 7. Restrictive CSP, no third-party scripts; logs contain no answer content | §4.5 headers, §4.8 | `apps/server/test/public-forms-headers.test.ts`: `GET /f/:id` CSP equals the expected string (no `unsafe-inline`, no host other than `'self'`), `cache-control: no-store`, `x-robots-tag`; with a built `dist` fixture (a temp `form.html`), every `<script src>` is same-origin; `apps/web/src/test/form-html.test.ts`: `form.html` has exactly one module script, local path, no inline script; the `public-form` sources import nothing from the app shell/extension; rendering the public page produces no element with a `style` attribute. Log test: in `public-forms-submit.test.ts`, captured pino lines (`logStream`, `LOG_LEVEL=trace`) contain none of the answer sentinels, file names, tokens or the public id, through every outcome (ok, 4xx, storage failure, 429). |
| 8. Security review document with the threat model committed and referenced | §6 → `docs/security/public-forms.md` | review |
| 9. CHANGELOG.md 1.5.0 entry for public forms | §4.9 | review (and the existing changelog lint, if run) |

Existing files expected to change (not tests): `FormRenderer.tsx` (additive props), `FormBuilderPage.tsx` (Share tab),
`QrCode.tsx` (uses `lib/qr.ts`), `attachments/index.ts` (exports), `events/form.ts`, `origin-check.ts`, `app.ts`,
`config.ts`, `rebuild.ts`, `context.ts`. Existing test files expected to change: none. If one has to (for example
`form-renderer.test.tsx`, `forms-builder.test.tsx` because of the new tab, or the two-factor QR test), the builder names
it in the handoff.

## 6. Threat model and controls (to commit as `docs/security/public-forms.md`)

Assets: the client's answers and documents (personal data), the firm's storage and its credentials (on the workstation
only), the firm's reputation (forms in its name), the Guildwise server's availability, the list of organizations and
forms. Trust boundaries: the public internet → the Guildwise server (public routes); the server → the runner
(authenticated WebSocket, GWP-63); the runner → the firm's storage. Actors: a client; a stranger with the URL; a bot; a
holder of a stolen or expired client link; a malicious uploader; an attacker who controls a client's network
(TLS assumed); an operator with database read access.

| # | Threat (STRIDE) | Control | Test |
|---|---|---|---|
| T1 | Enumerating forms or organizations (I) | 128-bit public id; unknown, unpublished, archived and suspended give the same 404 body; no org id or slug in URLs; no listing endpoint; per-IP limits | publish test (same body) |
| T2 | Forged or guessed client link (S) | HMAC-SHA256 over version, form id, link id, expiry with a purpose-derived key; constant-time compare; bound to one form | token unit tests |
| T3 | Stolen, expired or revoked link reused (S/E) | expiry checked from the signed value; revocation and single completed use from the row; token in the URL fragment (not in logs or `Referer`) | links tests |
| T4 | Personal data exposed by a link (I) | token holds only a random id and an expiry; the reference stays on the server; the page shows no client data | links test (reference not in token) |
| T5 | CSRF (T) | no cookie is read by the public API; Origin check on every non-GET `/api/*` (existing); JSON-only bodies except the raw part upload, which needs the upload token header (a cross-site form cannot set it) | negative test (no token → refused) |
| T6 | Replay of a submission (T/R) | session token single use (unique `session_nonce`), short-lived upload token bound to one submission, complete is idempotent, link consumed on complete | negative tests |
| T7 | Spam and bots (D) | honeypot, minimum fill time, proof of work on the session, rate limits per IP and per form | negative + limits tests |
| T8 | Flooding the server or the firm's storage (D) | buckets per IP/form, `AOM_FORMS_MAX_FILES`, `…_MAX_SUBMISSION_BYTES`, per-file limit before reading, GWP-63 in-flight cap and window (2 MiB per transfer), one upload at a time per page | limits test |
| T9 | Oversize upload exhausting memory or disk (D) | `content-length` required and checked before reading; byte counter aborts at the declared size (and the relay's own `too_large`); stream piped to the relay, never buffered whole, never written to disk | negative test (longer body) |
| T10 | Malicious file type, renamed executable (T/E on the firm's side) | per-field allowlist reduced to `FORM_UPLOAD_TYPES` (MIME rules expanded by our table, browser type ignored), magic-byte check of the head, executables refused by extension and by content, macro Office types and SVG not accepted, content type set by us | shared + negative tests |
| T11 | Malware inside an allowed type (E on the firm's side) | **not handled in this card**: follow-up runner-side scan (§3.6); the file never reaches Guildwise storage or other users | — |
| T12 | Path traversal or odd names in storage (T) | `sanitiseUploadName`, GWP-63 `renderStoragePath`/`sanitizeStorageSegment` (a value can never add a folder), GWP-64 template checks (`..`, leading slash), never overwrite (`storageClashName`) | shared tests (GWP-63, GWP-64) |
| T13 | XSS on the public page (T/E) | React escaping only (no `dangerouslySetInnerHTML`); help text rendered as text; CSP without `unsafe-inline`, `script-src 'self'`, `default-src 'none'`; no third-party scripts; `frame-ancestors 'none'` (clickjacking) | headers tests |
| T14 | XSS via the readable HTML copy opened by the firm (T) | every value escaped; no script; meta CSP `default-src 'none'`; uploads never embedded | answers-doc test |
| T15 | Answer content leaking into Guildwise storage or logs (I) | answers only in request memory; table holds references; routes silent; one metadata log line; pino redaction; error handler never echoes input; validation errors carry codes, not values or messages; no `reportServerError` payload | table dump + log scan |
| T16 | Leaking where the firm stores data (I) | `publicFormView` strips connections, folders and templates | shared test |
| T17 | A partial submission seen as complete (R) | complete only after both answers documents have references; claim with a conditional update; JSON written last | failure test |
| T18 | Lost answers on a phone (availability for the client) | answers kept in memory and `sessionStorage` (tab-scoped); retry re-sends only missing parts | web test |
| T19 | Spoofed client IP via `X-Forwarded-For` (S) | per-form limits unaffected; deploy behind a proxy (docs); hop-count setting as a follow-up | — (documented) |
| T20 | Operator with DB read access (I) | the DB holds no answers or files; tokens are signed with `AOM_SECRET_KEY`, not stored; storage credentials are on the workstation (GWP-63) | table dump |
| T21 | Runner offline drops a submission silently (R) | start refuses before anything is uploaded; mid-flight offline leaves the row not complete; the client is told (hook) | offline test |

Residual risks: malware inside allowed types (T11, follow-up); orphaned uploads after an expired submission
(firm's storage, no Guildwise copy; follow-up `storage.delete`); per-process rate limits on multi-instance hosting
(GWP-69); a compromised Guildwise server could serve altered JavaScript (same honest limit as the integrations page).

## 7. Risks

| Risk | Mitigation |
|---|---|
| A later change adds inline `style` attributes to the renderer | the public-page test asserts no `style` attribute; fallback `style-src-attr 'unsafe-inline'` only, pinned by the test |
| Changing `FormRenderer` breaks the builder preview | all new props optional and ignored in `mode="preview"`; the existing `form-renderer.test.tsx` must pass unchanged |
| A field's `allowedTypes` lists something we never accept (`.exe`, `.docm`, `image/svg+xml`) | dropped by `acceptedUploadExtensions`; the publish panel warns; a field left with nothing acceptable blocks publish |
| PoW too slow on old phones | solved in a worker while typing; 16 bits ≈ 65 000 hashes; `AOM_FORMS_POW_BITS` lowers it |
| `AOM_SECRET_KEY` not set: signing key from the DB | as today for unsubscribe/media links; docs say set it; rotation invalidates links |
| A published form whose destination connection is removed later | start → 409 `destination_missing` (non-retryable message); the publish panel warns (reads GWP-63 health) |
| Big uploads on slow mobile networks exceed `AOM_STORAGE_WRITE_TIMEOUT_MS` | the deadline is GWP-63's (`ctx.config.storage.writeTimeoutMs`); the page shows "taking longer than usual" and the retry resends only that file; flag to GWP-63 if it proves short in UAT |
| Hosted: request and runner socket on different instances | GWP-69 routes `storage.write` (GWP-63 note) |

## 8. Assumptions about the dependencies (checked 2026-11-04, see §0)

| # | Assumption | Dependency | Result |
|---|---|---|---|
| 1 | `ctx.services.storage.write(req)` with the GWP-63 §4.4 signature, `runner_offline` at once | GWP-63 | holds (`storage-relay/hub.ts`) |
| 2 | `renderStoragePath` vars and empty → `_` | GWP-63 | holds; every key must be present (§4.3 part step 4) |
| 3 | `StorageReference` shape | GWP-63 | holds |
| 4 | Connections carry `workstation_id`, `ctx.services.runners.isOnline(ws)` | GWP-63 | holds |
| 5 | Forms versioned per org with a `FormDefinition` zod schema; a published version is pinned | GWP-64 | holds; archived forms added to the 404 cases |
| 6 | Shared `validateAnswers(def, answers, files)` → field + code | GWP-64 | **revised**: `validateFormAnswers(def, answers, {strict})`, wrapped by `checkPublicAnswers` (§4.2) |
| 7 | File field and form settings names | GWP-64 | **revised**: `maxSizeBytes`, `allowedTypes` with MIME patterns, nullable `connectionId`, field `id`, `settings.*`, GWP-64 defaults (§3.3, §4.2, §4.3, §4.7) |
| 8 | Logo readable through a GWP-64 function | GWP-64 | holds (`readFormLogo`) |
| 9 | Renderer free of the app shell, classes only | GWP-64 | **revised**: shell-free and class-only (CSP stands), but its submit/state API needs additive public-mode props (§4.5) |

## 9. Recommendation

Serve published forms at `/f/<128-bit id>` from a separate small Vite entry with its own strict CSP; sign per-client
links as `v1.<linkId>.<exp>.<HMAC>` carried in the URL fragment, with a row for revocation and single use; protect the
public routes with silent logging, per-IP and per-form token buckets, a honeypot, a minimum fill time and a
proof of work on a single-use session token; submit in three steps (start, one streamed PUT per file through
`ctx.services.storage.write`, complete), write the answers as JSON plus a readable HTML copy, keep only a reference row,
and mark complete only after every write returned a reference. Reuse GWP-64's validator through a thin server wrapper
that ignores the browser's file type, and extend GWP-64's renderer with optional public-mode props. Virus scanning is a
runner-side follow-up.

Follow-ups (backlog suggestions): runner-side malware scan of uploads; `storage.delete` cleanup for expired
submissions; PDF copy of the answers; configurable proxy hop count instead of `trustProxy: true`.

> Update (GWP-147): an upload now reaches the runner in two ways: through the server relay (local folders, vaults) or straight from the browser to the provider (OneDrive, Google Drive, S3). See `GWP-147-direct-browser-to-storage-uploads-for-cloud-connec.md`.
