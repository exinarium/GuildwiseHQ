# GWP-142 PDF copy of a form's answers

Status: design, ready to build. Checked against the working branch `main` at `f6b71d8d` (the card names
release/1.6.0; the project's working branch is `main`, and the planning note found the same code on release/1.6.0 at
`b648d067`).

## 1. The question

When a public form (GWP-65) is submitted, the firm's storage receives the answers as `.json` and `.html`. The card asks
for a third copy, a `.pdf` with the same content as the HTML, made on the firm's runner (never on the server), in the
same folder with the same base name. Rendering must not be able to fail a submission. If it fails, the desk gets one
notice. Text in any script must render correctly, long answers must wrap across pages, and answer text must never be
treated as markup. The renderer must ship through the runner installer on every supported platform.

## 2. What is already in place (AC "record what was found before build")

| Piece | Where | State |
| --- | --- | --- |
| Answers JSON builder | `apps/server/src/public-forms/answers-doc.ts` `buildAnswersJson` | Done. `v: 1`, answers in field order, files with references. |
| Answers HTML builder | same file, `buildAnswersHtml`, `escapeHtml`, `AnswersDocFile` | Done. Static HTML with every value escaped, its own CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:`, no script, no external resource. Holds the title, `Submitted <ISO time>`, version and short submission id, `Client reference:` when there is a link, a table of question/answer in field order (`\n` → `<br>`), and a Files table (label, name, size, stored path). **No logo** is in the HTML today, so the PDF has none either (requirement 1 says "where the HTML has it"). |
| Hand-off to the workstation | `apps/server/src/public-forms/routes.ts` completion route, loop `for (const kind of ['html','json'])` (about line 1031) | Done. Each document is one `ctx.services.storage.write(...)` (the GWP-63 relay, `apps/server/src/storage-relay/hub.ts` `StorageRelay.write`), html first, then json. The references go to `form_submissions.answers_refs` (jsonb `{html, json}`) after each write, so a retry skips what is already stored. `destinationWorkstations` (`commands/forms-offline.ts`) is used only for the availability check, not for the write. |
| Runner write path | `apps/runner/src/storage/service.ts` `StorageService.open/chunk/end`; connectors `local.ts` `LocalConnector.put`, `gdrive.ts` `GDriveConnector.put` (+ OneDrive, S3, vault) | Done. The file is spooled to `<data dir>/tmp/storage/<transferId>.part`, the scan (GWP-126) runs on file answers, then `connector.put(target, spooled)`. A name clash gets `-2`, `-3`... The write is journaled per submission so `storage.discard` can roll the whole submission back. |
| Offline-held submissions (GWP-68) | `public-forms/offline.ts`, `commands/forms-offline.ts` | Done. **The server holds only the encrypted contact email, never the answers** (decision 5, ledger fbe4e064). When the runner is back, the client gets a secure link and submits again through the normal completion route. So any change to the completion route also covers held submissions. No separate "write later" path exists or is needed. |
| PDF output or renderer | anywhere in `apps/runner`, `apps/server/src/public-forms`, `packages/shared` | **None.** No PDF library or browser is a runner dependency. `playwright-core` exists in the repo only for the server's video worker (`packages/video/src/browser.ts`) and E2E. |

Conclusion: the PDF copy does not exist end to end, so the card must be built. Everything else is in place and is
reused.

## 3. Options compared

### 3.1 Renderer

| | A. Chromium headless shell through `playwright-core` (chosen) | B. Pure-JS layout (`pdfkit` + bundled fonts + `bidi-js`) | C. Typst (WASM or napi) |
| --- | --- | --- | --- |
| Fidelity to the HTML (req. 3) | Prints the received HTML itself, so the PDF matches the HTML by construction | Our own HTML reader and table layout re-create the look: two renderers that can drift | HTML → Typst conversion: a second template |
| Accents, non-Latin, RTL (req. 6) | Full shaping (HarfBuzz), bidi (UAX #9), font fallback | fontkit shapes but has **no bidi**. Arabic comes out backwards unless we add our own reorder and shaping ([bidi-shaper notes](https://cdn.jsdelivr.net/npm/bidi-shaper@0.1.2/README.md)). CJK needs ~10–16 MB of fonts per script | Good shaping and bidi |
| Long answers across pages | Chromium table fragmentation and `overflow-wrap` | We write the line breaking and page breaking | Good |
| Security (no script, no network) | JS turned off in the context, offline context, every request aborted, plus the HTML's own CSP: four layers | Cannot run script or fetch anything | Template-injection risk unless data is passed as JSON |
| Packaging | `playwright-core` (Apache-2.0, 14 MB unpacked, no install script) in the tgz. The browser binary (`chromium-headless-shell` rev 1243, Chrome 153, BSD-3-Clause + Chromium third-party notices) is downloaded per platform by the installer, about 90–110 MB download and about 250–300 MB on disk (builder measures and records). Linux also needs system libraries and fonts (apt) | Platform-neutral, about 10 MB plus fonts, fits the single tgz | The napi build has per-platform optional deps, which breaks the single `--ignore-scripts` tgz. The WASM build is experimental |
| Build effort and risk | Small: the same pattern as `packages/video/src/browser.ts` and the Dockerfile's `playwright-core/cli.js install --with-deps` | Large: HTML reader, layout, bidi, fonts. High risk on the "non-Latin shows correctly" AC | Large, immature in Node |

**Decision: A.** It is the only option that meets requirement 3 ("rendered from the HTML copy ... so the PDF and HTML
always show the same content") and requirement 6 without writing a typesetter. The repository already uses it, it runs
on every runner platform (Linux/WSL2, macOS, native Windows), and the installers already install system packages and
download tools. The cost is disk size and an install-time download, recorded above. B is the fallback only if the owner
rejects the size; it would need its own card.

Constraints the choice must respect:

- The runner tgz stays one platform-neutral package (`scripts/package-runner.sh`, `npm install --omit=dev
  --ignore-scripts`). `playwright-core` downloads nothing at npm install. The browser is fetched by the installer or by
  the runner itself (3.3), never by npm.
- The browser lives in `<data dir>/browsers` (set `PLAYWRIGHT_BROWSERS_PATH` before the dynamic `import('playwright-core')`),
  not in the user's global Playwright cache, so the runner's copy is independent of any developer toolchain.

### 3.2 Where the PDF is made

| Option | Verdict |
| --- | --- |
| **(chosen) The html write carries a `derive: { pdf: true }` flag. After `connector.put` of the HTML, the runner renders its own spooled copy of that HTML, puts `<base>.pdf` in the same folder, journals it under the submission, and reports the result inside the html write's `storage.write.result`** | One round trip. The PDF is made from exactly the bytes written as `.html`. The discard rollback covers it (it is journaled before the result is sent). The server sees only a reference. |
| Server sends a third write of kind `pdf` | Would need the server to render: breaks requirement 3 and the constraint. Rejected. |
| Runner renders asynchronously after replying, with a new frame for the outcome | Faster reply, but races with `storage.discard` (a json failure can roll back before the PDF lands, leaving an orphan) and needs a new frame type and server state. Rejected; the inline budget below keeps the delay bounded. |
| Runner detects "text/html + submission" on its own | Implicit and fragile; a later HTML write of another kind would get a PDF. Rejected. |

**Time budget:** the render plus PDF put run inside the html transfer's existing deadline (`deadlineMs`, default 60 s).
They are capped at `min(20 s, deadline − now − 3 s)`. If less than 2 s is left, the runner skips straight to
`pdf_timeout`. The submission's limits do not change (constraint "never delays a submission past today's limits").
Typical cost: a warm browser takes about 0.2–0.5 s, a cold start about 1–2 s, plus one small put.

### 3.3 Getting the browser onto every workstation

- **New runner command** `guildwise-runner pdf-renderer install [--with-deps]` / `pdf-renderer status`. It wraps
  `playwright-core`'s registry: `install --only-shell chromium` (only `chromium-headless-shell`) into
  `<data dir>/browsers`. `--with-deps` (Linux only) runs `install-deps chromium-headless-shell` and also installs
  `fonts-noto-core` (Arabic, Hebrew, Indic, Thai). CJK fonts (`fonts-wqy-zenhei`, `fonts-ipafont-gothic`) come with
  Playwright's deps list.
- **Linux/WSL2 installer** (`apps/server/src/installer/templates/linux.sh`): a new step after "Downloading the runner",
  "Installing the PDF renderer". It installs the system packages with the existing `pkg_install` (sudo is already used
  there), then runs `pdf-renderer install` as the user. **Not fatal:** on failure it warns ("PDF copies of form answers
  stay off until `guildwise-runner pdf-renderer install` succeeds") and the install goes on.
- **macOS installer** (`macos.sh`): the same step without deps (macOS fonts cover every script).
- **Windows script**: runs the Linux installer inside Ubuntu, so nothing extra. Native Windows (not recommended): the
  manual step goes in `docs/RUNNER.md`.
- **Self-update and repair:** a new runner version can pin a new browser revision. On start, if `status` is missing,
  the runner starts a background `install --only-shell` (no sudo, no deps), logs one line, and retries at most once per
  start. Until it is ready, renders report `pdf_unavailable` (so the desk gets the notice and nothing breaks).
- **`guildwise-runner doctor`** prints `PDF renderer: ready (Chrome Headless Shell <version>)` or
  `missing — run guildwise-runner pdf-renderer install`.

## 4. Design

### 4.1 Shared protocol (`packages/shared/src/protocol/runner.ts`)

The fields are additive and optional, so `PROTOCOL_VERSION` stays the same (an old peer strips unknown keys):

```ts
// StorageWriteOpenSchema: add
/** Set only on the answers HTML of a public form submission: the runner also writes a PDF made from it. */
derive: z.object({ pdf: z.literal(true) }).optional(),

// StorageWriteResultSchema: add
derived: z.object({
  pdf: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), reference: StorageReferenceSchema }),
    z.object({ ok: z.literal(false), code: z.enum(['pdf_unavailable', 'pdf_failed', 'pdf_timeout', 'pdf_write_failed']) }),
  ]),
}).optional(),
```

Add `formPdfMissing: 'form_pdf_missing'` to `DESK_SUBKIND` (`packages/shared/src/testing/index.ts`, next to
`formOfflineLink`). If the web app maps subkinds to labels or icons, add the entry there too (an alert with only
Dismiss).

### 4.2 Server

`apps/server/src/storage-relay/hub.ts`:
- `StorageWriteRequest` gets `derive?: { pdf: true }`, forwarded in `storage.write.open` like `scan`.
- `StorageWriteResult` ok-variant gets `derived?: {...}`. `onResult` passes `r.derived` through.
- In the receipt check, if `derived.pdf.ok`, check `reference.connectionId === req.connectionId` and
  `contentType === 'application/pdf'`. If either fails, replace it with `{ ok:false, code:'pdf_failed' }`. Never fail
  the html write because of the PDF. The relay's log line stays the same (size, outcome, latency only).

`apps/server/src/public-forms/routes.ts` (completion route):
- `refs` type becomes `{ html?; json?; pdf?: StorageReference; pdfError?: string }`.
- Html write only: pass `derive: { pdf: true }`. On `w.ok`, set `refs.pdf = w.derived?.pdf?.ok ? w.derived.pdf.reference
  : undefined`, `refs.pdfError = w.derived?.pdf?.ok ? undefined : (w.derived?.pdf?.code ?? 'pdf_unavailable')` (no
  `derived` means an old runner, which counts as missing). Persist with the existing `answers_refs` update. The json
  write is unchanged and never carries `derive`. File parts are unchanged.
- In the completing transaction (inside `if (n.rowCount)`, so it happens **once** per submission even with retries and
  concurrent completes):
  - `FormSubmitted.payload.answers` = `refs.pdf ? [html, json, pdf] : [html, json]` (the schema is already
    `z.array(StorageReferenceSchema)`).
  - If `!refs.pdf`, append a `DeskItemCreated` alert (same shape as `raiseCaseAlert` in `forms-offline.ts`):
    `subkind: DESK_SUBKIND.formPdfMissing`, `subjectKey: form-pdf-missing:<sid>`, `blocking:false`, option Dismiss,
    `scope: orgScope(pub.orgId)`.
    - Title: `PDF copy missing: <form title>`.
    - Body: `The answers were saved as JSON and HTML, but the PDF copy could not be made on the firm's workstation.
      Open the HTML copy (<html path>) and print it if you need a PDF.` plus `Client reference: <ref>` when there is
      one, and `Submission <first 8 of sid>`.
    - `data: { formId, submissionId, htmlPath, reason: refs.pdfError }`.
    - **No answer text, no file names from answers**, only the form title, reference and stored path, which the desk
      list already shows.
- No other change: no new table or column, nothing about the PDF in logs, and the visitor API and responses are
  unchanged.

`apps/server/src/commands/public-forms.ts` `listSubmissions`: add `if (refs.pdf) stored.push({ label: 'Answers (PDF)',
path: refs.pdf.path })` after the readable entry, so the desk can see which copies exist (optional per the card; it is
one line, so include it).

`apps/server/src/public-forms/answers-doc.ts`: **print-friendly styling only**. Same markup, same text, same escaping,
and the JSON is untouched. Extend the `<style>`:

```css
body{font-family:system-ui,"Noto Sans","Liberation Sans",Arial,sans-serif;...existing...}
th,td{overflow-wrap:anywhere;word-break:break-word}
td,th,h1,p{unicode-bidi:plaintext}            /* each paragraph takes its direction from its first strong letter */
@page{size:A4;margin:16mm 14mm}
@media print{body{max-width:none;margin:0;padding:0}tr{break-inside:auto}h1,h2{break-after:avoid}}
```

`unicode-bidi: plaintext` is CSS, not markup. It makes an Arabic or Hebrew answer read right-to-left in both the
browser and the PDF, like `dir="auto"`, without changing the HTML structure.

### 4.3 Runner

**New `apps/runner/src/storage/pdf.ts`:**

```ts
export type PdfFailure = 'pdf_unavailable' | 'pdf_failed' | 'pdf_timeout';
export class PdfError extends Error { constructor(readonly code: PdfFailure) { super(code); } } // message = code only

export interface PdfRenderer {
  /** HTML in, PDF bytes out. Throws PdfError. Never logs or returns the HTML in an error. */
  render(html: string, signal: AbortSignal): Promise<Buffer>;
  status(): Promise<{ ready: boolean; version?: string }>;
  install(opts: { withDeps: boolean; log: (l: string) => void }): Promise<void>;
  close(): Promise<void>;
}

export function chromiumPdfRenderer(o: { browsersPath: string; idleMs?: number /* 10 min */; maxConcurrent?: number /* 2 */ }): PdfRenderer
```

Render steps (the security controls are mandatory):
1. Lazy launch, kept warm and closed after `idleMs` with no render. Use
   `process.env.PLAYWRIGHT_BROWSERS_PATH ??= browsersPath` before `await import('playwright-core')`. Then
   `chromium.launch({ headless: true, args: ['--disable-gpu','--no-first-run','--disable-extensions',
   '--disable-background-networking','--disable-sync','--disable-component-update','--disable-default-apps'] })`. Keep
   Playwright's default `chromiumSandbox:false` (Ubuntu 24.04 AppArmor blocks unprivileged user namespaces). That is
   acceptable because scripts and network are off. A missing executable or a launch error gives `pdf_unavailable`.
2. Per render: `browser.newContext({ javaScriptEnabled: false, offline: true, serviceWorkers: 'block',
   acceptDownloads: false })`; `context.route('**/*', r => r.abort())` (data: URLs are not routed, so an embedded image
   still works); `page.setContent(html, { waitUntil: 'load', timeout })`; `page.emulateMedia({ media: 'print' })`;
   `page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate:
   '<span></span>', footerTemplate: '<div style="font-size:8px;width:100%;text-align:center"><span
   class="pageNumber"></span> / <span class="totalPages"></span></div>' })`. The footer holds no answer content. Always
   close the context in `finally`.
3. A semaphore of `maxConcurrent`. Waiting counts against the caller's signal. Abort or timeout gives `pdf_timeout`.
   Any other error gives `pdf_failed`. A disconnected browser is dropped so the next render relaunches.

**`apps/runner/src/storage/service.ts`:**
- `StorageServiceDeps.pdf?: PdfRenderer` (absent means `pdf_unavailable`; the test seam).
- `Transfer` gets `derive?: { pdf: true }` (copied in `open` like `scan`) and `derivedWritten?: { path; providerId? }`.
- In `end()`, after the html `put` succeeded, the journal entry was added, and the existing "aborted while the put was
  running" check passed, and before `t.finished = true`:
  ```ts
  const derived = t.derive?.pdf && t.submission ? await this.derivePdf(t, conn, written) : undefined;
  if (t.finished) { await this.deleteWritten(t, conn); return; } // aborted during the PDF: delete html AND pdf
  ...
  this.result(t.id, { reference, ...(derived ? { derived } : {}) });
  ```
- `derivePdf(t, conn, written)`:
  - `budget = Math.min(20_000, t.deadline - this.now() - 3_000)`. If `budget < 2_000`, return `pdf_timeout`.
  - `html = await readFile(t.file, 'utf8')`. The spool is still on disk; `cleanup` removes it later.
  - `pdf = await this.deps.pdf.render(html, abortAfter(budget, t.controller.signal))`.
  - Write to `join(spoolDir, `${t.id}.pdf`)` with mode `0o600`.
  - `name = basename(written.path).replace(/\.html?$/i, '') + '.pdf'`. This uses the **written** html name, so an html
    clash suffix (`-2`) is carried over.
  - `connector.put({ folder: t.target.folder, name }, { file, size, sha256, contentType: 'application/pdf' }, signal)`.
  - On success, `journal.add({ submissionId, connectionId, path, providerId })`, set `t.derivedWritten`, and return
    `{ pdf: { ok: true, reference: {v:1, connectionId, kind, path, providerId?, size, sha256, contentType:
    'application/pdf', writtenAt} } }`.
  - A put error gives `pdf_write_failed`. A `PdfError` gives its code.
  - Exactly **one** log line, whatever the outcome:
    `storage.pdf conn=<id> submission=<sid> transfer=<tid> <ok|code> size=<n> <ms>ms`. Use `logWarn` on failure.
    Never `err.message`, never HTML, never a path or name.
  - Remove the `.pdf` spool file in `finally`.
- `deleteWritten` also deletes `t.derivedWritten` (and drops its journal entry). `rollbackSubmission` already deletes
  every journal entry, so `storage.discard` removes the PDF with no change.
- The PDF never fails the html write: every PDF error ends in `derived.pdf.ok=false` and the html reference is still
  returned.

**`apps/runner/src/runner.ts`:** build `chromiumPdfRenderer({ browsersPath: join(this.paths.root, 'browsers') })`, pass
it as `pdf`, `close()` it on shutdown, and start the background `status()`→`install({withDeps:false})` once after start
(3.3).

**`apps/runner/src/cli.ts`:** add the `pdf-renderer install [--with-deps]` and `pdf-renderer status` subcommands, plus
one line in `doctor`.

**`apps/runner/package.json`:** add `"playwright-core": "^1.63.0"` to `dependencies` (same version as server and video,
already in the lockfile). It stays external in the tsup runner bundle (dependencies are externalised by default). It
must **not** be reachable from `src/aom/aom-cli.ts` (that bundle has `noExternal: [/.*/]`), and `storage/pdf.ts` is
imported only from `runner.ts`, `cli.ts` and `service.ts` types.

### 4.4 Docs and notices

- `docs/investigations/GWP-65-...md` §3.3: list the third file, `<same base>.pdf`, made on the runner from the HTML,
  with the "PDF copy missing" notice when it cannot be made.
- `docs/security/public-forms.md`: add a threat-model row for the renderer (JS off, offline, every request aborted, CSP,
  no answer content in logs or notice).
- `docs/RUNNER.md`: the installer step, `pdf-renderer install/status`, the browsers folder, disk size, and the
  native-Windows manual step.
- `apps/runner/THIRD_PARTY_NOTICES`: playwright-core (Apache-2.0) and Chrome Headless Shell (BSD-3-Clause, Chromium
  credits at `chrome://credits` / the bundled `ABOUT` / `LICENSE` in the browser folder; the browser is downloaded by
  the installer, not inside the tgz).
- `CHANGELOG.md` entry; bump `RUNNER_VERSION` per the usual practice.

## 5. Acceptance criteria → design → tests

| AC | Design | Test |
| --- | --- | --- |
| Card records what was found before build | §2 of this report and the card comment | n/a |
| Online submission: `.json`, `.html`, `.pdf`, same base name, same folder (local + Google Drive) | §4.3 `derivePdf` (name from written html), §4.2 `derive` flag on the html write | runner `storage-service-pdf.test.ts`: with `LocalConnector` in a temp dir and a fake renderer, html open with `derive.pdf` gives `answers-x.html` + `answers-x.pdf`, the result has `derived.pdf.ok` and a reference with `application/pdf`. Html clash: the existing `answers-x.html` makes the html `-2` and the pdf follows. Google Drive: the same through the existing fetch double in `storage-connectors.test.ts` style (two uploads, the second named `.pdf`, same parent). Server `public-forms-submit.test.ts`: the fake storage returns `derived` and the test asserts `answers_refs.pdf`, `FormSubmitted.answers.length === 3`, and that only the html write had `derive` |
| PDF shows title, date/time, reference, every Q/A in order, file names and sizes, matching the HTML | Renders the HTML itself | runner `pdf-render.test.ts` (real Chromium, `it.skipIf(!ready)`): build a sample with `buildAnswersHtml`-shaped HTML (a fixture string; the runner must not import server code), extract text with `pdf-parse` (devDependency `1.1.1`, already in the lockfile; import `pdf-parse/lib/pdf-parse.js`) and check that the title, ISO time, `Client reference: R-1`, every label/answer in order (index check) and `scan.pdf (12 KB)` are present. Output starts with `%PDF-` |
| Long multi-line answer gives a multi-page PDF, nothing cut off | `overflow-wrap:anywhere`, table fragmentation, A4 `@page` | same file: 400 numbered lines plus one 3,000-character unbroken token gives `numpages > 1`, every `line-N` marker and the full token (allowing for inserted line breaks) extracted |
| Accented and non-Latin characters | Chromium shaping and fallback, `fonts-noto-core` on Linux, `unicode-bidi:plaintext` | same file: `Zoë Ångström Łódź`, `Привет`, `Ελληνικά` extracted exactly. `שלום עולם` and `مرحبا` extracted, compared without regard to order (pdf.js may return visual order) |
| HTML in an answer shows as literal text | Escaped by `buildAnswersHtml`, JS off, network aborted | runner: an answer `<script>document.title='x'</script><b>bold</b><img src="https://example.invalid/a.png">` gives the literal string in the extracted text and the route handler sees no request (count aborted routes = 0 non-data requests made, or an assert-only route spy). Server: the existing `public-forms-answers-doc.test.ts` escaping tests still pass. Add one asserting the new CSS is present and the markup is unchanged otherwise |
| Renderer missing or failing: submission succeeds, JSON/HTML/uploads written, one desk notice, no answer content in logs | §4.3 PDF errors never fail the html write. §4.2 notice in the completing tx with `subjectKey` | runner: `pdf` dep absent gives `pdf_unavailable`; a renderer that throws gives `pdf_failed`; a renderer that hangs gives `pdf_timeout` within the budget; a put that throws on `.pdf` gives `pdf_write_failed`. In every case the html reference is ok, the html file exists, no `.pdf`, no spool file is left, and the captured log lines contain none of the sample answer strings and exactly one `storage.pdf` line. Server: `derived` absent or failed means the submission completes `200`, one `DeskItemCreated` with subkind `form_pdf_missing` whose title, body and data contain none of the answers. A retry of complete after a json failure, and a second complete call, still give **one** notice |
| Held submission (GWP-68) gets its PDF | The held case re-submits through the same completion route (§2) | server `forms-offline-journey.test.ts` or `public-forms-submit.test.ts`: complete through the secure link and assert the html write carries `derive.pdf` and `answers_refs.pdf` is stored |
| Server does not write, store or log the PDF or answers beyond today | Only a reference in `answers_refs` and the event, like html/json today. The relay log is unchanged | server: assert the relay log entries for the html write have only the existing keys. Code review: no PDF bytes in server code |
| Existing tests pass, new tests cover PDF and failure paths | n/a | runner `vitest run test/storage-*.test.ts test/pdf-*.test.ts`; server public-forms unit tests. Integration/E2E (Playwright with a deployed runner) and installer Docker runs (`scripts/test-installer-docker.sh`) are for testers and DevOps |

Rollback when the json write fails afterwards: covered by the existing `storage.discard` journal. Add a runner test
that `handle('storage.discard')` after an html+pdf write deletes both files.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Install size (about 250–300 MB browser plus Linux libs and fonts) and a download at install | Not fatal and repairable (`pdf-renderer install`). Recorded in RUNNER.md. The fallback (option B) is noted for the owner if size is refused |
| Browser revision changes with a runner update | Background install on start. Until ready, `pdf_unavailable` gives the notice, never a failure |
| Linux with missing fonts gives tofu boxes | `fonts-noto-core` plus Playwright's deps in the installer. The Docker installer test renders the multilingual sample once (DevOps) |
| Chromium memory (about 100–150 MB while warm) | Lazy launch, closed after 10 min idle, at most 2 concurrent renders |
| Slow cold start delays the visitor | Capped at 20 s inside the existing deadline. Typically under 2 s |
| Unsandboxed Chromium (`--no-sandbox`) | Content is our escaped HTML, JS is off, the context is offline with every request aborted, plus the CSP |
| An error message carries content into logs | Only the `PdfError.code` is logged. A test asserts no answer string in the log lines |
| Overlap with group cards | GWP-126/127 have merged (scan and remove lock are on `main`). GWP-143 (relay delete) and GWP-147 (direct uploads) are queued in the same group and touch `service.ts`/`hub.ts`. This card only adds a branch in `end()`, `derivePdf`, and an optional field in the open/result frames. Keep the change local so those cards rebase cleanly |
| Old runner with a new server | `derive` is stripped by the old runner, no `derived` comes back, and the desk gets the notice (true: no PDF). No error |

## 7. Recommendation

Build it as designed: Chromium headless shell through `playwright-core`, rendering on the runner from the spooled HTML,
signalled by a `derive.pdf` flag on the html write, with the outcome returned in the same write result. The PDF is
journaled with the submission, and one "PDF copy missing" desk alert is raised by the server in the completing
transaction when there is no PDF reference. Ship the browser through a non-fatal installer step plus a runner
self-repair, and record its size and licence in RUNNER.md and THIRD_PARTY_NOTICES.

Follow-up outside this card (backlog suggestion): the HTML copy has no firm logo. If the owner wants one in both
copies, embed it as a `data:` image in `buildAnswersHtml` (the CSP already allows `img-src data:`), and the PDF follows
automatically.
