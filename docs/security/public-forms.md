# Public forms: security review

Status: reviewed against the code as built (release 1.5.0). Design: `docs/investigations/GWP-65-public-form-hosting-public-url-qr-code-per-client.md`.
Tests are named per threat. The public side lives in `apps/server/src/public-forms/`; the shared rules in
`packages/shared/src/forms/public.ts`; the page in `apps/web/src/public-form/`.

## What is public, and what is kept

A published form is open to anyone who has its address, `/f/<id>`, or a personal link. A client fills it in without a
Guildwise login. The answers and the uploaded files go to the firm's own storage through the firm's runner (storage
connections) and nowhere else.

The server keeps one row per submission (`form_submissions`): ids, status, timestamps, the form version, the personal link
used, the declared size and checksum of each file, and the storage references the runner returned. It keeps no answer, no
file content, no IP address, no user agent and no file name (a stored path may contain the original file name when the
firm's folder template uses `{original}`; that path is a storage reference in the firm's own storage).

## Assets, boundaries, actors

Assets: the client's answers and documents (personal data), the firm's storage and its credentials (on the workstation
only), the firm's reputation (forms in its name), the server's availability, the list of organizations and forms.

Trust boundaries: the public internet to the server (the public routes); the server to the runner (the authenticated
WebSocket of the storage write relay); the runner to the firm's storage.

Actors: a client; a stranger with the address; a bot; the holder of a stolen, expired or revoked personal link; a malicious
uploader; someone who controls a client's network (TLS assumed); an operator with read access to the database.

## Threats and controls

| # | Threat | Control | Test |
|---|---|---|---|
| T1 | Enumerating forms or organizations | 128-bit public id; unknown, unpublished, archived and suspended-organization addresses all give the same 404 body and the same page; no organization id or name in any address; no listing endpoint; per-IP limit on every public request | `public-forms-publish.test.ts`, `public-forms-headers.test.ts` |
| T2 | Forged or guessed personal link | `v1.<linkId>.<expiry>.<HMAC-SHA256>` over version, form id, link id and expiry with a key derived from `AOM_SECRET_KEY` for this purpose only; constant-time compare; bound to one form | `form-client-link-token.test.ts` |
| T3 | Stolen, expired or revoked link | Expiry is part of the signed value; revocation and single completed use come from the row; the token travels in the address fragment (`#c=`), which is never sent to a server, a proxy log or a `Referer`; the page removes it from the address bar | `public-forms-publish.test.ts` (links), `public-form-page.test.tsx` |
| T4 | Personal data exposed by a link | The token holds a random id and an expiry only; the firm's client reference stays in the row and in the firm's storage; the public page shows no client data | `public-forms-publish.test.ts` |
| T5 | CSRF | The public API reads no cookie; every non-GET `/api/*` request must carry the app's `Origin` (existing check), except under `/api/public/forms/`, where the `Origin` value is not compared (the routes read no cookie, `credentials: omit`, JSON bodies and the `x-upload-token` header force a preflight the server never allows, and `Origin` can be forged by non-browser clients; a missing `Origin` is still refused); bodies are JSON, except the raw file part, which also needs the upload token header (a cross-site form cannot set it) | `public-forms-submit.test.ts` (negative), `public-forms-origin.test.ts` |
| T6 | Replay of a submission | A page session is single use (`session_nonce` is unique), signed, bound to one form version and expires (`AOM_FORMS_SESSION_TTL_MIN`); the upload token is signed, bound to one submission and expires; complete is idempotent; a personal link is consumed by the first completed submission | `public-forms-submit.test.ts` |
| T7 | Spam and bots | Honeypot field, minimum fill time (`AOM_FORMS_MIN_FILL_MS`), proof of work on the session (`AOM_FORMS_POW_BITS`), and the rate limits. No third-party CAPTCHA, so no third-party script and no client address sent to a third party | `public-forms-bots.test.ts`, `public-forms-ratelimit.test.ts` |
| T8 | Flooding the server or the firm's storage | Token buckets per client address and per form (429 with `Retry-After`); at most `AOM_FORMS_MAX_FILES` files and `AOM_FORMS_MAX_SUBMISSION_BYTES` per submission; the per-file limit is checked before a byte is read; the write relay's in-flight cap and credit window; one file at a time per page | `public-forms-ratelimit.test.ts` |
| T9 | Oversize upload exhausting memory or disk | `Content-Length` is required, must equal the announced size and is checked before the body is read; the stream is piped to the relay in 256 KiB chunks and never buffered whole or written to disk; the relay stops at the announced size | `public-forms-submit.test.ts` (negative) |
| T10 | Malicious file type, renamed executable | Per-field allow list reduced to a fixed table (`FORM_UPLOAD_TYPES`: no SVG, no macro-enabled Office formats, no programs); MIME rules are expanded by our table, the browser's type is ignored; the first 4100 bytes are checked against the extension (magic bytes); executables are refused by extension and by content whatever the field allows; the content type stored is ours | `form-upload-types.test.ts`, `form-public-answers.test.ts`, `public-forms-submit.test.ts` |
| T11 | Malware inside an allowed type | **Handled when the workstation turns the scan on** (`uploadScan.enabled`, off by default). The runner streams each file answer to clamd before the storage write; an infected file, or a scan that cannot run, is never written (fail closed), what the submission already wrote is deleted, and an infected file is kept in a local owner-only quarantine folder. The submitter sees a generic message (no signature, engine or path). The file never reaches Guildwise storage or other users, and the server neither stores nor scans it. Known limit: a part stored on another workstation is removed when that workstation comes online (25 hours) | `storage-scan.test.ts`, `storage-service-scan.test.ts`, `public-forms-malware.test.ts`, `public-form-messages.test.ts` |
| T12 | Path traversal or odd names in storage | Names are sanitised (`sanitiseUploadName`); the storage template engine sanitises every value and a value can never add a folder; template checks refuse `..` and a leading slash; an existing file is never overwritten | shared storage and forms tests |
| T13 | Script injection on the public page | React escaping only, no `dangerouslySetInnerHTML`; help text rendered as text; `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'` and no inline script or style; `x-frame-options: DENY` | `public-forms-publish.test.ts`, `public-forms-headers.test.ts`, `form-html.test.ts`, `public-form-page.test.tsx` |
| T14 | Script in the readable copy the firm opens | Every value is HTML-escaped; no script; its own `default-src 'none'` policy; uploads are listed, never embedded | `public-forms-answers-doc.test.ts` |
| T14b | Script or network use while the PDF copy is made | The runner prints its own copy of the escaped HTML in Chrome Headless Shell with JavaScript off, an offline context, every request aborted and the page's own `default-src 'none'` policy; only the error code is logged, never answer text; the desk notice when the copy is missing holds no answers | `storage-service-pdf.test.ts`, `pdf-render.test.ts`, `public-forms-pdf.test.ts` |
| T15 | Answer content in logs or tables | Answers live in request memory only; the table holds references; the public routes log nothing by default and write one metadata line per call (operation, ids, status, size, time); the error handler never echoes input; validation errors carry a field id and a code, never a value or message; the pino redaction list covers `answers`, `website` and the token headers; the public id is redacted from logged URLs | `public-forms-submit.test.ts` (table dump and log scan) |
| T16 | Leaking where the firm stores data | The public view of a form blanks every connection, folder and name template and the logo id | `form-public-answers.test.ts`, `public-forms-publish.test.ts` |
| T17 | A partial submission seen as complete | Complete only after every file and both answers documents have a storage reference; the claim is a conditional update; the JSON is written last; nothing is marked complete when a write fails | `public-forms-submit.test.ts` (storage failure) |
| T18 | Client loses their answers on a phone | Answers are kept in the page and mirrored to `sessionStorage` (never `localStorage`); a retry re-sends only the files not stored; a file that cannot be restored is asked for again | `public-form-page.test.tsx` |
| T19 | Spoofed client address (`X-Forwarded-For`) | The per-form limit does not depend on the address. `AOM_TRUST_PROXY` (default: loopback only) decides which peers may set the header: it is honoured only from the configured proxy addresses or hop count, so a client that reaches the server directly is limited on its socket address; an invalid value stops the server at startup (docs/SELF-HOSTING.md "Running behind a reverse proxy") | `trust-proxy.test.ts`, `public-forms-ratelimit.test.ts` (rotating `X-Forwarded-For`) |
| T20 | Operator with database access | The database holds no answers or files; tokens are signed, not stored; storage credentials stay on the workstation | table dump in `public-forms-submit.test.ts` |
| T21 | A runner that is offline drops a submission silently | The start step refuses before anything is uploaded; an outage mid-way leaves the row not complete; the client is told, and the hook for the offline flow is called | `public-forms-submit.test.ts` (offline) |

## Residual risks and follow-ups

- Malware inside an allowed file type (T11): handled only on workstations that turn the scan on.
- Uploads that landed in the firm's storage for a submission that later timed out remain there; a delete operation on the
  write relay would let the server clean them up.
- Rate limits are per server process; a multi-instance hosted deployment needs a shared store (hosted edge settings).
- The page's script is served by the same server; a compromised server could serve altered script, as with the rest of
  the web app.

## Direct uploads to cloud storage (GWP-147)

For OneDrive/SharePoint, Google Drive and S3 destinations the file goes from the browser to the provider with a
short-lived, single-use grant issued by the runner; the server passes the address on without storing or logging it.
Owner decision (ledger 7b91aa22, option o2): every check above stays and there is no relay fallback for cloud
destinations. Where each check runs for a direct upload:

| Check | Where |
|---|---|
| T8 count, total size, per-file size | server at start, and again before an address is issued |
| T10 type allow list by extension | server at start (no address for a refused type) |
| T10 magic bytes, executable by content | runner, on the staged object, with the same `checkUploadHead` |
| T9 exact size and sha256 | S3 signature (length, checksum) and always the runner, on the staged object |
| T11 malware scan | runner, on the staged object, fail closed, same quarantine and rollback |
| T12 path sanitising, no overwrite | runner; the browser only writes a staging name, the runner moves the file after the checks |
| T16 host exposure | the page rules (`connect-src`) list the exact upload hosts of the form's destinations, reported by the runner and kept in server memory; the host is visible to the visitor, nothing else about the destination is |

A cloud destination with no reported upload host refuses at start (503 `upload_unavailable`); a failed grant fails the
submission; a relay `PUT` for a direct part is refused with 409 `upload_mode` before any byte is read. The runner offline
still gives the secure-link flow (GWP-68). `AOM_FORMS_DIRECT_UPLOADS` (default `true`; `false` = every destination relays
as in 1.6.0).

## Settings

`AOM_FORMS_POW_BITS` (16; 0 turns the puzzle off, at most 22), `AOM_FORMS_MIN_FILL_MS` (3000), `AOM_FORMS_SESSION_TTL_MIN`
(240), `AOM_FORMS_SUBMISSION_TTL_MIN` (120), `AOM_FORMS_MAX_FILES` (20), `AOM_FORMS_MAX_SUBMISSION_BYTES` (100 MiB),
`AOM_FORMS_IP_PER_MIN` / `AOM_FORMS_IP_BURST` (120 / 60), `AOM_FORMS_IP_SUBMITS_PER_HOUR` / `AOM_FORMS_IP_SUBMIT_BURST`
(10 / 5), `AOM_FORMS_FORM_SUBMITS_PER_MIN` / `AOM_FORMS_FORM_SUBMIT_BURST` (60 / 30). The per-file size is the smaller of the
field's limit and `AOM_STORAGE_MAX_FILE_BYTES`. Rotating `AOM_SECRET_KEY` ends every personal link and open page session.

## Runner offline: secure link later (release 1.5.0)

| Id | Threat | Handling |
|---|---|---|
| T-off-1 | Inbox bombing through the offline panel | Session, minimum fill time, honeypot and proof of work as for a submission; 3 requests per hour per client address, 30 per hour per form, 500 open cases per organization; one open case per address per form and per personal link; the desk resends at most 3 times. |
| T-off-2 | Email addresses leaking from the database | Only the address is held, encrypted (AES-256-GCM, purpose key, case id as authenticated data), in an operational table that is not event-sourced. Cleared when the case closes. The dedupe hash is keyed and cleared with it. Never in events, logs (`email` is redacted), desk items or metrics. A failing mail transport is never logged or returned as is (its text can quote the address): only a fixed message with the case id is logged, and the desk gets a plain `mail_failed` answer. |
| T-off-3 | Finding out whether an address already has a case | The same `202` answer for a new case and a duplicate. |
| T-off-4 | The secure link forwarded or reused | A personal client link of purpose `offline`: signed, expiring, consumed by the first completed submission, revoked when the journey is continued. The token travels in the URL fragment. |
| T-off-5 | An insider reading held addresses | Show email is for an Owner or Admin only, on request, and writes `FormOfflineEmailViewed` (without the address). The address is not kept in the desk item. |

The public form view carries the firm's name (organization name) for the offline panel, and nothing else about the organization.

The email contains the firm name and the link only: no form title, no answer and no client reference.
