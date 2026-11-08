# GWP-132: Public forms: exempt `/api/public/forms/` from the CSRF origin check

## Question

`checkOrigin` (`apps/server/src/auth/origin-check.ts`) refuses every public form POST/PUT with `403 bad_origin` when the
page `/f/<id>` is opened at an address that is neither `AOM_PUBLIC_ORIGIN` nor in `AOM_EXTRA_ORIGINS` (for example a LAN
IP on a plain-http install). Is that already fixed on release/1.6.0? If not, how should the public form API be exempted
without loosening the check for any cookie-authenticated route?

## 1. What is already on release/1.6.0 (requirement 0)

Checked at `origin/release/1.6.0` = `b648d067` (the card branch HEAD is the same commit) and guildwise-cloud
`origin/release/1.6.0` = `a64c5bb` ("chore: pin core to b648d067f5", so the hosted build runs exactly this core).

| Item | Status | Evidence |
| --- | --- | --- |
| (a) `checkOrigin` skips `/api/public/forms/` | **Not done** | `EXEMPT_PREFIXES` lists `/api/runner/pair`, `/api/test/`, `/api/v1/`, `/api/inbound/mail/`, `/api/hooks/`, `/api/runner/uploads/`, `/api/worker/video/`. No public forms entry. No extension adds it either (`app.ts:349` collects `originExemptPrefixes`; core registers none for forms). |
| (b) A server test covers the skip | **Not done** | No test mentions `bad_origin`. `extra-origins.test.ts` tests `checkOrigin` with `/api/auth/login` only; every public forms test sends `origin: http://aom.test` (`helpers/public-forms.ts:52`, `helpers/app.ts:98`), so the refusal is never exercised. |
| (c) guildwise-cloud has its own origin check | **No** | `server/src/index.ts:80` only *adds* exempt prefixes (`/api/billing/payfast/itn`, `/api/billing/paystack/webhook`) to core's list through `originExemptPrefixes`; `createApp` takes the union, so it cannot undo a core exemption. `deploy/Caddyfile` and `deploy/nginx-guildwisehq.conf` proxy `/api/public/forms/*` with body limits and IP headers only: no `Origin`/`Referer` rule. Nothing to raise as a separate cloud card. |
| GWP-111 visitor message for `bad_origin` | Present | `apps/web/src/public-form/messages.ts:72` (`case 'bad_origin'`). Stays as the fallback. |

Conclusion: the work is still missing and the card must be built (server only, GuildwiseHQ). The hosted build picks the
change up through `createApp` with the next core pin; no guildwise-cloud change is needed.

## 2. Findings

- **The routes** (`public-forms/routes.ts`, registered at `app.ts:528`): `GET /f/:publicId`, `GET /api/public/forms/:publicId`,
  `GET .../logo`, `POST .../submissions`, `POST .../offline-requests`, `PUT .../submissions/:sid/parts/:index`,
  `GET .../submissions/:sid`, `POST .../submissions/:sid/complete`. Every state-changing route is under
  `/api/public/forms/<publicId>/...`; there is no route at `/api/public/forms` or `/api/public/forms/` itself.
- **No cookie**: the plugin header (line 122) says no cookie is read; the only cookie-related use is
  `ctx.config.secureCookies` to pick the page CSP. No `req.user`, `requireOrg` or session cookie anywhere in
  `public-forms/`. The "session" in the bodies is a signed form session token (`verifySession`), not a cookie.
- **The page**: `apps/web/src/public-form/api.ts:27` calls `fetch('/api/public/forms/...', { credentials: 'omit' })`,
  a relative (same-origin) URL with the default `cors` mode. Browsers always send `Origin` on a POST/PUT fetch, so the
  visitor's request carries the address the page was opened at, e.g. `http://192.168.1.50:4700`.
- **Why the check protects nothing there**: no ambient credential (cookie) is involved, so a cross-site page gains
  nothing it could not do by calling the API itself; JSON bodies and the `x-upload-token` header already force a CORS
  preflight that this server never answers; a non-browser client can write any `Origin` anyway. The real protections are
  the upload token, the rate limits, proof of work, the fill-time/honeypot session and the destination check, all of
  which stay.
- **Plain http from a LAN IP otherwise works**: the file checksum falls back to plain JS when `crypto.subtle` is missing
  (`apps/web/src/public-form/sha256.ts`), the page CSP is `connect-src 'self'`, and `secureCookies` is off on http.
  So the origin check is the only blocker for AC 8.
- **Router**: Fastify defaults (case-sensitive, no duplicate-slash folding, no dot-segment resolution); `checkOrigin`
  reads the raw `req.url` before routing. A path that merely *starts* with the prefix but escapes it cannot reach
  another route, so a prefix test is sound (same property the existing `EXEMPT_PREFIXES` rely on).

### A conflict in the card, and how the design resolves it

Requirement 1 says the routes must not be refused "because of their Origin header", but AC 3 / test plan step 3 say a
request **with no Origin** must "behave exactly as before". Before, a missing `Origin` is refused (`originAllowed`
returns false for `undefined`). A plain prefix exemption would change that to "handled by the route".

The design keeps both: on the public forms prefix the **value** of `Origin` is no longer compared, but a request
**without** `Origin` is still refused with `403 bad_origin`, exactly as today. This costs nothing: every browser sends
`Origin` on these POST/PUT requests, so real visitors are never affected, and requiring a header that any client can
write is neither a loss nor a gain in security. It keeps the change minimal and AC 3 literal.

## 3. Options

| Option | Fit | Verdict |
| --- | --- | --- |
| A. Add `/api/public/forms/` to `EXEMPT_PREFIXES` | One line, but also lets a no-`Origin` request through: breaks AC 3 ("no Origin behaves as before"). | Rejected |
| B. Register the prefix through an extension's `originExemptPrefixes` (`app.ts:349`) | Same full exemption as A, and hides a core rule in the extension hook meant for hosted add-ons. | Rejected |
| C. In `checkOrigin`: on `/api/public/forms/<something>`, accept any present `Origin`; missing `Origin` still 403 | Meets every requirement and AC, stays in the file the card names, no change to `originAllowed`/`checkWsOrigin`/`checkContentType`. | **Recommended** |
| D. Allow the request's own `Host` as an origin for these paths (`Origin === scheme://Host`) | Tighter-looking, but `Host` and `X-Forwarded-Proto` are client/proxy controlled behind `trustProxy: true`, so it adds complexity without protection, and it is a rule the card does not ask for. | Rejected |

## 4. Design (option C)

### 4.1 `apps/server/src/auth/origin-check.ts` (the only source file to change)

Add a constant and one early return in `checkOrigin`, after the existing exemptions and before the allowlist test.
Leave `originAllowed`, `checkContentType` and `checkWsOrigin` untouched.

```ts
/**
 * The public form API (`public-forms/routes.ts`): a visitor may open `/f/<id>` at any address the server answers on, for
 * example a LAN IP on a plain-http install that is not AOM_PUBLIC_ORIGIN. Comparing the Origin value protects nothing
 * here: these routes read no cookie (the page fetches with `credentials: 'omit'`), their JSON bodies and the
 * x-upload-token header already need a CORS preflight this server never allows, and a non-browser client can forge
 * Origin anyway. Upload tokens, rate limits, proof of work and the destination check are the protection. A browser always
 * sends Origin on these requests, so a request without one is still refused as before.
 */
const PUBLIC_FORMS_PREFIX = '/api/public/forms/';
const isPublicFormApi = (path: string): boolean =>
  path.startsWith(PUBLIC_FORMS_PREFIX) && path.length > PUBLIC_FORMS_PREFIX.length;

export function checkOrigin(config: Config, req: FastifyRequest, extraExempt: readonly string[] = []): void {
  if (SAFE.has(req.method)) return;
  const path = req.url.split('?')[0] ?? '';
  if (!path.startsWith('/api/')) return;
  if (EXEMPT_PREFIXES.some((p) => path.startsWith(p)) || extraExempt.some((p) => path.startsWith(p))) return;
  if (isPublicFormApi(path) && req.headers.origin !== undefined) return;
  if (!originAllowed(config, req.headers.origin)) {
    throw new HttpError(403, 'bad_origin', 'Origin header missing or not allowed');
  }
}
```

Behaviour table (non-GET methods; GET/HEAD/OPTIONS unchanged, they were never checked):

| Path (query string ignored) | Origin | Before | After |
| --- | --- | --- | --- |
| `/api/public/forms/<id>/...` | foreign (e.g. `http://192.168.1.50:3000`) | 403 `bad_origin` | handled by the route |
| `/api/public/forms/<id>/...` | `AOM_PUBLIC_ORIGIN` / extra origin | handled | handled (same) |
| `/api/public/forms/<id>/...` | missing | 403 `bad_origin` | 403 `bad_origin` (same) |
| `/api/public/forms/<id>/...?x=1` | foreign | 403 | handled (path-only match) |
| `/api/public/formsX`, `/api/public/forms`, `/api/public/forms/` | foreign | 403 | 403 (same) |
| `/api/forms/...` (formRoutes, publicFormAdminRoutes, forms-offline), every other `/api/*` | foreign | 403 | 403 (same) |
| WebSocket upgrade (`checkWsOrigin`) | any | unchanged | unchanged |

`checkContentType` still runs right after `checkOrigin` in the same `onRequest` hook (`app.ts:418-421`), so a public form
POST with a non-JSON body still gets 415, and the raw file part keeps its existing exception.

No change to `app.ts`, `public-forms/routes.ts`, `tokens.ts`, `limits`, the web app, config, or guildwise-cloud.
No CORS headers, no OPTIONS handling, no new setting.

### 4.2 Tests (vitest, `apps/server/test/`)

New file `apps/server/test/public-forms-origin.test.ts` (or a new `describe` in `extra-origins.test.ts`; a separate file
is preferred so `extra-origins.test.ts` stays unchanged as the AC asks).

1. **Unit, direct `checkOrigin`** (same fake-request style as `extra-origins.test.ts`, config with
   `AOM_PUBLIC_ORIGIN: 'https://aom.example.com/'`, `AOM_EXTRA_ORIGINS` unset):
   - POST and PUT to `/api/public/forms/abc/submissions`, `/api/public/forms/abc/submissions/s1/parts/0`,
     `/api/public/forms/abc/submissions/s1/complete`, `/api/public/forms/abc/offline-requests` and
     `/api/public/forms/abc/submissions?x=1` with `Origin: http://192.168.1.50:3000` do not throw. Also DELETE/PATCH on the
     prefix (the check covers every non-safe method).
   - Same paths with no Origin throw `/Origin/`; with the public origin do not throw.
   - Foreign Origin on `/api/public/formsX`, `/api/public/forms`, `/api/public/forms/`, `/api/public/formsX/abc`,
     `/api/forms/abc/publish`, `/api/forms`, `/api/forms/offline-requests/abc/resend`, `/api/auth/login` throws `/Origin/`.
   - `checkWsOrigin(cfg, 'http://192.168.1.50:3000')` is false (unchanged).
2. **Through the app** (no test reaches `checkOrigin` via `createApp` today), using `usePublicFormsWorld` from
   `helpers/public-forms.ts` with the same relaxed limits as `public-forms-submit.test.ts`:
   - Full happy path with `FOREIGN = 'http://192.168.1.50:3000'`: `pf.published(pf.definition())`, `pf.load(publicId)`,
     then `pf.post('/api/public/forms/<id>/submissions', body, { origin: FOREIGN })` gives 201; each
     `pf.put(.../parts/<i>, bytes, { origin: FOREIGN, 'x-upload-token': token, 'x-file-name': ... })` gives 200;
     `.../complete` with `{ origin: FOREIGN, 'x-upload-token': token }` gives 200 and `status: 'complete'`. Build the start
     body like `pf.start` does (session, nonce `'0'`, website `''`, answers, file manifest); `pf.submit` takes no headers.
   - The same start with the configured origin (`ORIGIN`, the helper default) gives 201 (as before).
   - The start with **no** Origin gives 403 `bad_origin`. Note: `call()` merges `origin: ORIGIN` first and drops
     `undefined` header values, so it cannot send a request without Origin; use `pf.w.t.app.inject({ method: 'POST',
     url, headers: { 'content-type': 'application/json' }, payload })` for this case.
   - Foreign Origin with the owner's cookie on `POST /api/forms/<formId>/unpublish` (publicFormAdminRoutes) and
     `POST /api/forms` (formRoutes) gives 403 `bad_origin`; on `POST /api/public/formsX` gives 403 `bad_origin`
     (global `onRequest` hooks run for the 404 route too; if the builder finds a 404 instead, keep this case in the unit
     test only and say so).
   - A foreign-Origin PUT of a part with a wrong `x-upload-token` is still refused with the same status as today
     (shows the token check still applies), and a foreign-Origin POST with `content-type: text/plain` still gets 415.
3. Run unchanged: `extra-origins.test.ts`, `public-forms-submit.test.ts`, and the other `public-forms-*.test.ts`
   (bots, limits, ratelimit, headers), then the server suite, typecheck and lint. The server tests need the
   `aom_test` Postgres from `vitest.config.ts`.

### 4.3 Docs (the builder updates them with the code)

- `docs/security/public-forms.md`, threat T5 (line 37): replace "every non-GET `/api/*` request must carry the app's
  `Origin` (existing check)" with: the public API reads no cookie; its POST/PUT need an `Origin` header but its value is
  not compared (the page may be opened at any address the server answers on); JSON bodies and the upload token header
  block cross-site form posts. Name the new test file in the test column.
- `docs/SELF-HOSTING.md`, troubleshooting "Every write returns `403 bad_origin`" (lines 451-455): drop the sentence that
  says public forms are affected the same way; say public forms work from any address the server answers on.
- `docs/ARCHITECTURE.md` section 18 CSRF bullet (line 2043): add "except the public form API (`/api/public/forms/`),
  which reads no cookie: there a present `Origin` is not compared". Optionally one line in section 43.

### 4.4 PR description (security note for the reviewer, required by the card)

State that the exemption is deliberate and limited to `/api/public/forms/<...>`: the routes read no cookie (the page
sends `credentials: 'omit'`), JSON bodies and the `x-upload-token` header already force a CORS preflight the server
never allows, `Origin` can be forged by non-browser clients, and the upload tokens, rate limits, proof of work,
content-type check and destination check are unchanged. A missing `Origin` is still refused.

## 5. Risks

- **Spreading to cookie routes**: guarded by the exact prefix with a trailing slash and a non-empty rest, path-only
  match, and negative tests for `/api/forms/...`, look-alikes and `/api/auth/login`. No public form route reads a
  cookie today; a future route under this prefix that reads one would be a bug the comment warns against.
- **Abuse from scripts**: unchanged; scripts could always set `Origin`. Rate limits and proof of work are the control.
- **Cross-site browser pages**: still cannot submit with JSON (preflight fails, no CORS headers). The raw part PUT needs
  `x-upload-token`, which also forces a preflight. Out of scope per the card.
- **Caddy/nginx**: no origin rule at either edge (checked core `deploy/` and cloud `deploy/`); nothing to change.
- **Overlap**: GWP-137 also edits `app.ts` (`createApp`); this design does not touch `app.ts`, so no conflict.

## 6. Acceptance criteria mapping

| AC | Design |
| --- | --- |
| Card records what is on release/1.6.0 | Section 1 (a: missing, b: missing, c: no cloud origin check; not closable, build needed). Also posted on the card. |
| Foreign Origin POST/PUT on `/api/public/forms/...` no longer 403 | 4.1 early return; tests 4.2.1 and 4.2.2 happy path (201/200/200). |
| No Origin and matching Origin behave as before | 4.1 keeps missing-Origin refused and matching Origin accepted; tests 4.2.1 and 4.2.2. |
| Foreign Origin outside the prefix still 403 (admin, formRoutes, `/api/public/formsX`) | `isPublicFormApi` exact prefix; tests 4.2.1 and 4.2.2. |
| `checkWsOrigin` unchanged, `extra-origins.test.ts` passes | Not edited; unit assertion plus unchanged file run (4.2.3). |
| Token, rate limit, proof of work, content-type checks unchanged | Only `checkOrigin` changes; `checkContentType` still runs; existing `public-forms-*` tests run unchanged; token and 415 cases with foreign Origin in 4.2.2. |
| New automated server test | `apps/server/test/public-forms-origin.test.ts`. |
| LAN IP on plain http can submit with a file, no bad_origin message | 4.1 plus the findings in section 2 (no other secure-context blocker); manual test plan step 7 and 8 for the tester. |
