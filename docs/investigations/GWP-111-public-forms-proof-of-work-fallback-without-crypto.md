# GWP-111 Public forms: proof of work and file hashing without `crypto.subtle` (plain-http installs)

Status: design, ready to build. Module: `apps/web` (public form bundle) only. Server unchanged.

## 1. The question

A public form (GWP-65) opened over plain http on a LAN or self-hosted address (for example UAT at
`http://<ip>:4700`) is not a secure context, so the browser offers no `crypto.subtle`. The backlog item says the proof
of work (PoW) uses `crypto.subtle.digest` in a worker and therefore cannot submit. Should we add a pure-JS SHA-256
fallback or require https?

## 2. Findings

### 2.1 The PoW already runs without `crypto.subtle`

The backlog item was raised from the GWP-65 *design* (report section "pow.worker.ts: `crypto.subtle.digest('SHA-256')`
loop"). The build did something different:

| Code | What it does today |
| --- | --- |
| `apps/web/src/public-form/sha256.ts` `sha256Bytes` | Correct, synchronous pure-JS SHA-256 (FIPS 180-4 constants, big-endian length, multi-block). Already checked against `node:crypto` for 0..70 000-byte inputs and `'abc'` in `public-form-crypto.test.ts`. |
| `pow.ts` `powOk` | `sha256Bytes(session + ':' + nonce)` and the same leading-zero-bits rule as the server's `powValid` (`apps/server/src/public-forms/tokens.ts:86`). Never touches `crypto.subtle`. |
| `pow.worker.ts` | Tight loop over `powOk`, posts the nonce (base36, matches the server's `^[A-Za-z0-9_-]{1,40}$`). |
| `pow.ts` `solvePow` | Module worker; on `onerror` or a throwing constructor it falls back to `solvePowHere` (main thread, 2000-nonce slices, `setTimeout(0)` between slices). |
| `sha256.ts` `sha256File` | Reads the whole file, uses `crypto.subtle.digest` when `crypto.subtle` exists, else (or on throw) `sha256Bytes`. |

So no part of the submit path *requires* `crypto.subtle` today. The PoW is correct over plain http.

### 2.2 What does break over plain http (server configuration, not crypto)

Reading the server shows two ways a plain-http LAN address fails. Neither is about SHA-256:

1. **`403 bad_origin` on every POST/PUT.** `checkOrigin` (`apps/server/src/auth/origin-check.ts`) runs on every
   non-GET `/api/*` request and `/api/public/forms/` is not exempt. If the page is opened at an origin that is neither
   `AOM_PUBLIC_ORIGIN` nor listed in `AOM_EXTRA_ORIGINS`, `POST .../submissions` is refused. The page has no case for
   `bad_origin` in `describePublicError`, so the visitor sees the generic "Something went wrong. Your answers are still
   here. Try again." That looks like a client bug and is the most likely cause of the original report. The fix is
   configuration, already documented in `docs/SELF-HOSTING.md` ("Every write returns 403 bad_origin": add the exact
   origin to `AOM_EXTRA_ORIGINS`). DevOps was asked (request ae7440d7) for UAT's `AOM_PUBLIC_ORIGIN` and
   `AOM_EXTRA_ORIGINS`. The share links of a form are built from `AOM_PUBLIC_ORIGIN`, so a visitor who uses the link
   the firm gave them is never refused.
2. **`upgrade-insecure-requests`.** When `AOM_PUBLIC_ORIGIN` is https, `publicPageCsp(true)` adds this directive, so a
   page opened over `http://<ip>` upgrades its own script, style, worker and fetch requests to `https://<ip>:4700` and
   never loads. That is a misconfiguration (an https origin opened over http) and the signed-in app behaves the same.
   No change.

The card says the server stays unchanged, so this card does **not** change the origin check. It does add a clear
visitor message for `bad_origin` (section 4.4) so the failure is no longer a generic error. Exempting the public
endpoints from the origin check would be security-neutral (no cookie is read, JSON bodies and custom headers trigger
a CORS preflight that the server never allows, and a script outside a browser forges `Origin` anyway). That is a server
change, so it goes on the backlog as a suggestion, not into this card.

### 2.3 What is still missing on the client (the real scope of this card)

- File hashing without `crypto.subtle` runs `sha256Bytes` on the whole file **on the main thread in one call**, and
  `sha256Bytes` copies the whole input into a padded buffer first (2x memory). For a 25 MiB attachment (the hosted
  limit, ledger f84a9061) this freezes the page. Measured in Node 22 on this workstation: about 350 ms for 25 MiB on
  a desktop CPU. A phone is 5-10 times slower, so 2-4 s of frozen page. Requirement 4 asks for chunks and a worker.
- No helper chooses the digest by feature, so nothing can be unit-tested for "which path is chosen" (AC3).
- No "this can take a little longer" line, no last-resort message, no case for `bad_origin` (requirements 6 and 7).
- `solvePow` never rejects. If the solver could not run at all, `begin()` would wait forever on `pow.current`.
- The main-thread fallback uses fixed 2000-nonce slices: about 10 ms on a desktop, but 50-100 ms on a slow phone,
  which makes typing stutter.

### 2.4 Measurements (Node 22.23, this workstation, `crypto.webcrypto`)

| Work | Pure JS (`sha256Bytes`) | `crypto.subtle.digest`, one await per hash | `crypto.subtle`, 256 per `Promise.all` |
| --- | --- | --- | --- |
| PoW, 65 536 hashes of `session:nonce` (16 bits, the expected work) | **314 ms** | 557 ms | 258 ms |
| One 25 MiB buffer | 354 ms | **20 ms** | n/a |

At 16 bits the number of tries is geometric with mean 65 536. The median is about 45 000 tries, the 95th percentile
about 196 000. Pure JS gives a desktop median well under 1 s and about 1-3 s on a mid-range phone. That is far from the
10 s alarm in the last AC. In browsers each `crypto.subtle.digest` call is a promise round trip to the browser's crypto
thread, so per-hash subtle is slower than in Node, not faster.

Conclusion: **for the PoW the pure-JS hash is the fast path in every context. For files `crypto.subtle` is the fast path.**

## 3. Options

| Option | For | Against |
| --- | --- | --- |
| O1. Pure-JS fallback, extending the existing `sha256.ts` (the card's choice) | Works on every install; the code is mostly there; no dependency | Needs an incremental hasher and a worker for files |
| O2. "Needs https" message only | Tiny | UAT and every self-hosted install without TLS cannot take submissions; rejected by the card |
| O3. Add a library (`@noble/hashes`, `js-sha256`) | Battle-tested, streaming | Second implementation of what `sha256.ts` already does correctly; a new runtime dependency the card forbids without reason; no gain |

**Recommendation: O1**, reusing and refactoring `sha256.ts` (one implementation, no new dependency). For AC3, see 4.1:
the PoW keeps the pure-JS hash in every context, and the subtle-or-JS choice applies to file hashing.

## 4. Design

### 4.1 Digest selection (requirements 1-2, AC3)

New, in `sha256.ts`:

```ts
/** The browser's SHA-256 when this page has one (https, localhost), else null (plain http). Feature test only. */
export function nativeSubtle(): SubtleCrypto | null {
  const s = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  return s && typeof s.digest === 'function' ? s : null;
}
export type DigestPath = 'subtle' | 'js';
export const fileDigestPath = (): DigestPath => (nativeSubtle() ? 'subtle' : 'js');
```

- Never look at `location.protocol`, `isSecureContext`, the hostname or the user agent.
- `sha256File` uses `fileDigestPath()`.
- The PoW always uses `sha256Bytes`, deliberately. Measured above: per-hash `crypto.subtle` is slower, and batched it is
  only equal. Switching the solver to subtle on https would make timing worse, which AC3 forbids ("timing does not get
  worse"). AC3's "the solver still uses crypto.subtle" rests on the premise that it uses subtle today. It does not,
  and never has since GWP-65 was built. The test for AC3 therefore asserts: (a) `fileDigestPath()` is `'subtle'` when
  `crypto.subtle.digest` exists and `'js'` when `crypto.subtle` or its `digest` is undefined; (b) `sha256File` calls
  `crypto.subtle.digest` when present (spy) and does not when absent; (c) the PoW gives the same nonce for the same
  session whether `crypto.subtle` is present or stubbed out, so https/localhost behaviour and timing do not change.
  This reading of AC3 was put to the owner as a non-blocking question. If the owner insists that the PoW use subtle on
  https, the fallback is a batched solver (`Promise.all` of 256 `crypto.subtle.digest` calls per round, the same
  `leadingZeroBits` check) behind `nativeSubtle()`, with the pure-JS loop otherwise. It is a contained change in
  `pow.worker.ts` and `solvePowHere`.

### 4.2 One SHA-256 implementation, now incremental (requirements 3-4)

Refactor `sha256.ts` without adding a second implementation:

```ts
export class Sha256 {
  private h = new Uint32Array(IV);          // the eight initial words
  private w = new Uint32Array(64);
  private buf = new Uint8Array(64); private bufLen = 0; private total = 0; // bytes
  update(data: Uint8Array): this { /* fill buf, compress each full 64-byte block straight from `data` via a DataView */ }
  digest(): Uint8Array { /* 0x80, zeros, 64-bit big-endian bit length (hi = Math.floor(total*8 / 2**32)), compress, out */ }
}
export function sha256Bytes(data: Uint8Array): Uint8Array { return new Sha256().update(data).digest(); }
```

- Move the existing compression loop (the `for (let i = 0; i < 64; i++)` body) into a private `compress(view, off)`
  unchanged, so the verified arithmetic is kept. `rotr`, `K` and `toHex` stay.
- No more whole-input padded copy. The PoW gets slightly faster: one 64-byte buffer is reused per call. A PoW input
  (`session:nonce`) is about 130 bytes, which means 3 blocks.
- Keep `powOk`'s per-call cost low: `sha256Bytes` may build a fresh `Sha256`. Optionally a module-level instance with
  `reset()`, but measure first and do not optimise without a number.

`sha256File(file, opts?)`:

```ts
const CHUNK = 1 << 20; // 1 MiB
export async function sha256File(file: Blob): Promise<string> {
  const subtle = nativeSubtle();
  if (subtle) {
    try { return toHex(new Uint8Array(await subtle.digest('SHA-256', await file.arrayBuffer()))); }
    catch { /* fall through to the JavaScript path */ }
  }
  return hashFileInWorker(file).catch(() => sha256FileHere(file));
}
/** Main thread, 1 MiB at a time, yielding between chunks so typing stays smooth. */
export async function sha256FileHere(file: Blob, chunk = CHUNK): Promise<string> {
  const h = new Sha256();
  for (let off = 0; off < file.size; off += chunk) {
    h.update(new Uint8Array(await file.slice(off, off + chunk).arrayBuffer()));
    await yieldToEventLoop();
  }
  return toHex(h.digest());
}
```

- `crypto.subtle` has no streaming digest, so the subtle path stays one-shot. Files are at most
  `AOM_STORAGE_MAX_FILE_BYTES` (25 MiB hosted), so this is fine, as it is today.
- `hashFileInWorker(file)`: the same worker module as the PoW (see 4.3), message `{ kind: 'file', file }`. A `File` is
  structured-cloneable; the worker runs the same chunk loop (no yield needed) and posts `{ kind: 'file', hex }`. A
  worker error, a construction failure or a missing `Worker` rejects, and the caller falls back to `sha256FileHere`.
- `begin()` in `PublicFormPage` hashes the files one after another (today `Promise.all` starts them all at once). That
  keeps at most one file in memory on the JS path. Keep the manifest order.

### 4.3 Worker and main-thread fallback (requirement 5)

`pow.worker.ts` becomes the public form's one worker and takes two messages:

```ts
type In  = { kind: 'pow'; session: string; bits: number } | { kind: 'file'; file: Blob };
type Out = { kind: 'pow'; nonce: string } | { kind: 'file'; hex: string } | { kind: 'error'; code: 'unsupported' };
```

- Wrap each handler in try/catch and post `{ kind: 'error', code: 'unsupported' }` on a throw, so the page does not
  wait forever. Keep the file name (the Vite `new URL('./pow.worker.ts', import.meta.url)` asset and CSP
  `worker-src 'self'` stay valid). The page's message must stay backward-tolerant in tests: accept `{kind:'pow'}`.
- `solvePow(session, bits): Promise<string>` **rejects** with `PowUnsupportedError` (new, exported from `pow.ts`) only
  when the worker path *and* `solvePowHere` both fail. A worker error or construction failure still falls back to the
  main thread, as today.
- `solvePowHere`: replace the fixed 2000-nonce slice with a time budget. Run until about 8 ms have passed
  (`performance.now()`, with `Date.now()` if absent), then `await yieldToEventLoop()`. Keep a `slice`/budget parameter
  for tests. This is what keeps typing smooth on a slow phone (AC7).
- `yieldToEventLoop = () => new Promise(r => setTimeout(r, 0))` in one place (shared by PoW and file hashing).
- `selfTest()`: a one-time check before solving that `toHex(sha256Bytes(enc('abc')))` equals the NIST digest. If it
  fails (a broken engine), throw `PowUnsupportedError`. It costs one hash. This is the concrete trigger for the last
  resort; otherwise the last resort is only reached when `TextEncoder`/typed arrays are missing.

### 4.4 Visitor messages (requirements 6-7, AC7-8)

`messages.ts` gets the new strings, all plain wording:

```ts
export const PUBLIC_TEXT = {
  slowCheck: 'Still checking your form. This can take a little longer on this device. Please keep this page open.',
  needsSecureLink:
    "This form can't be sent from this browser over this link. It needs a secure (https) link. Your answers are still here. Please contact the firm.",
} as const;
```

and two cases in `describePublicError`:

```ts
case 'pow_unsupported':   // raised by the page itself (PowUnsupportedError / file hash failure)
  return msg(PUBLIC_TEXT.needsSecureLink);                 // retry false, closed false: keep the form and answers
case 'bad_origin':        // the page was opened at an address the server does not accept (configuration)
  return msg("This form can't be sent from this address. Please use the link the firm gave you, or contact the firm.");
```

`PublicFormPage.tsx`:

- `pow.current` keeps type `Promise<string>`, but it must not raise an unhandled rejection while the person types.
  Attach `p.catch(() => {})` once when it is created (the awaited copy still rejects in `begin()`). Do this in the
  three places where `solvePow` is called (`load`, `goOffline`, the stale-session branch of `sendOfflineRequest`).
  A small `startPow(dto)` helper is fine.
- `begin()`: start a 3000 ms timer (`SLOW_MS = 3000`, exported for tests) when the hashing and PoW wait starts (after
  `setProgress('Checking your files…')`). When it fires before both are done, `setProgress(PUBLIC_TEXT.slowCheck)`.
  Clear it in `finally`. Do not count the `minFillMs` wait (that is the bot timer, not slowness): pause or clear the
  timer around `await wait(...)`, or start it again for the PoW wait.
- In `begin()`, convert `PowUnsupportedError`, and a hash failure on both paths, into
  `new PublicApiError(0, 'pow_unsupported', '…', false)`. The existing catch in `submit()` then shows it through
  `describePublicError` as a notice (role alert, no Try again) and leaves `phase.kind === 'form'`, so every answer and
  chosen file stays. No generic error is shown.
- `sendOfflineRequest` gets the same mapping (it awaits `pow.current` too).
- Do **not** import `SecureContextNotice`. It renders nothing when `isSecureContext` is not false, uses the signed-in
  app's wording about sealing secrets (`SECURE_CONTEXT_MESSAGE`), and would pull `@aom/shared` secure-context code and
  `components/ui.tsx` into the slim public bundle (commit 69a68376 slimmed it). Reuse its tone: the existing notice
  markup in the `status` block (`role="alert"`, the danger border classes) is the right place.

### 4.5 Bundle boundary

Everything new lives under `apps/web/src/public-form/`, which only `main.tsx` (the `form` Rollup input) imports. Do not
import from `apps/web/src/lib/secure.ts` or `packages/shared/src/secure-context.ts`. After the build, check that no
`index-*.js` chunk contains `Sha256`: `grep -l Sha256 apps/web/dist/assets/*.js` should list only the form entry and
the worker asset.

### 4.6 Server and security (requirement 8, AC6)

- No change in `apps/server/src/public-forms/**` or `apps/server/src/auth/origin-check.ts`. `powBits` stays the
  value of `AOM_FORMS_POW_BITS` (default 16) in the definition response. No request field or header can change it, and
  the client neither sends nor asks for one.
- The pure-JS hash computes the same bytes, so the server's `powValid` and its file-reference check (`routes.ts:829`,
  `reference.sha256 !== part.sha256`) accept the result unchanged.

## 5. Files to change

| File | Change |
| --- | --- |
| `apps/web/src/public-form/sha256.ts` | `Sha256` incremental class (existing compression moved, not rewritten), `sha256Bytes` as a wrapper, `nativeSubtle`, `fileDigestPath`, `sha256FileHere`, `hashFileInWorker`, `sha256File` with chunking and fallback, `yieldToEventLoop` |
| `apps/web/src/public-form/pow.ts` | `PowUnsupportedError`, `selfTest`, time-budget `solvePowHere`, `solvePow` that rejects only when both paths fail, `{kind}` messages |
| `apps/web/src/public-form/pow.worker.ts` | `pow` and `file` messages, try/catch with an `error` reply |
| `apps/web/src/public-form/messages.ts` | `PUBLIC_TEXT`, cases `pow_unsupported` and `bad_origin` |
| `apps/web/src/public-form/PublicFormPage.tsx` | `startPow` with a swallowed background rejection, files hashed one at a time, slow timer (`SLOW_MS`), unsupported mapping in `begin` and `sendOfflineRequest` |
| `apps/web/src/test/public-form-crypto.test.ts` | Tests 1-4 below |
| `apps/web/src/test/public-form-page.test.tsx` | Tests 5-7 below |
| `docs/SELF-HOSTING.md` (optional, a short note) | Under "Every write returns 403 bad_origin": public forms opened at a LAN address need the same `AOM_EXTRA_ORIGINS` entry |
| `CHANGELOG.md` Unreleased | "Public forms: attachments are hashed in the background on plain-http installs; clear messages when a form is slow to check or cannot be sent from this address." |

No change in: `apps/server/**`, `packages/shared/**`, `apps/web/src/components/SecureContextNotice.tsx`,
`apps/web/src/lib/secure.ts`, `OfflinePanel.tsx`.

## 6. Tests

Stub `crypto.subtle` in vitest with `vi.stubGlobal('crypto', { ...globalThis.crypto, subtle: undefined })` (or
`Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true })`) and restore it in
`afterEach` (`vi.unstubAllGlobals()`). jsdom has no `Worker`, so `solvePow` and `sha256File` take the main-thread paths
there. Stub a fake `Worker` class to test the worker branch and its `error` and `onerror` fallbacks.

`public-form-crypto.test.ts` (unit):

1. NIST vectors through `sha256Bytes` **and** through `Sha256.update` in uneven pieces (1, 63, 64, 65 bytes and the
   whole input): `''` → `e3b0c442…b855`; `'abc'` → `ba7816bf…15ad`; the 448-bit
   `'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'` → `248d6a61…19db06c1`; the 896-bit
   `'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrsnopqrstu'`
   → `cf5b16a7…7afee9d1`. Write the full hex in the test. Add a 1 MiB random buffer compared with `node:crypto` and
   with `await crypto.subtle.digest` (jsdom/Node has it). Keep the existing 0..70 000-byte loop.
2. Selection: `fileDigestPath()` is `'subtle'` with subtle present; `'js'` with `crypto.subtle` undefined; `'js'` with
   `crypto.subtle = {}` (no `digest`). `sha256File` calls a `digest` spy when present and does not call it when absent.
3. With subtle stubbed out: `await solvePow(SESSION, 16)` (the production default, read the number from the same
   constant as the test, not a lower one) returns a nonce for which `createHash('sha256').update(`${SESSION}:${nonce}`)`
   has 16 leading zero bits (recompute the server's rule, as the existing test does) and which matches
   `^[A-Za-z0-9_-]{1,40}$`. Also: the same session gives the same nonce with subtle present (no path change for
   https). About 0.3 s.
4. `sha256File` with subtle stubbed out on a 3.5 MiB `Blob`: equals `node:crypto`; `sha256FileHere(blob, 1000)` with
   an odd chunk size gives the same hex. A fake `Worker` that posts `{kind:'error'}` falls back to the main thread
   with the same result.
5. `solvePow` rejects with `PowUnsupportedError` when both the worker and the main-thread solver throw (stub `Worker`
   to throw and make `TextEncoder` throw, or inject a failing self-test).

`public-form-page.test.tsx` (component):

6. With subtle stubbed out, `powBits: 8` and a file field: submitting calls `start` with a nonce that satisfies 8 bits
   and a manifest `sha256` equal to the file's `node:crypto` hash; the success state is shown.
7. Slow: mock `../public-form/pow.ts` so `solvePow` returns a promise held open; with fake timers, advance past
   `SLOW_MS` after Send; `public-status` shows `PUBLIC_TEXT.slowCheck`; typing into `full_name` still updates the
   field. Then resolve and see the success state.
8. Unsupported: `solvePow` rejects with `PowUnsupportedError`. After Send, `public-notice` shows
   `PUBLIC_TEXT.needsSecureLink`, there is no `public-retry` button and no "Something went wrong" text, and the typed
   `full_name` value is still in the input.
9. `bad_origin`: `start` answers `403 {error:{code:'bad_origin'}}`; the notice shows the address message, not the
   generic one.
10. `public-form-offline.test.tsx` passes unchanged (do not edit it).

Run: `pnpm --filter @aom/web exec vitest run src/test/public-form-crypto.test.ts src/test/public-form-page.test.tsx src/test/public-form-offline.test.tsx`
then `pnpm --filter @aom/web test` once, `pnpm --filter @aom/web typecheck` and `pnpm lint` (biome).

## 7. Acceptance criteria mapped

| AC | How it is met |
| --- | --- |
| Plain http, no attachments, submits | The PoW is already pure JS (2.1); tests 3 and 6; manual UAT step 9. **Precondition:** the LAN origin is `AOM_PUBLIC_ORIGIN` or listed in `AOM_EXTRA_ORIGINS` (2.2), otherwise the server answers 403 `bad_origin`, now with a clear message (test 9). DevOps confirms UAT's settings |
| Plain http, attachment, hash matches the server | Chunked JS hash, in the worker or on the main thread (4.2); tests 4 and 6; the server check at `routes.ts:829` is unchanged |
| https/localhost: subtle path, no worse timing, unit test of the path | `fileDigestPath()` is `'subtle'` and the subtle spy is called (test 2). The PoW is unchanged in every context, so it is not slower (test 3, second part). See 4.1 for the reading of "the solver still uses crypto.subtle" (owner asked) |
| NIST vectors, 1 MB, equals subtle | Test 1 |
| subtle stubbed: solvePow nonce accepted at production difficulty | Test 3 (16 bits, the server rule recomputed) |
| No server diff, no lowering parameter | 4.6; reviewer checks `git diff --stat main -- apps/server` is empty |
| > 3 s: the 'little longer' line, page responsive | `SLOW_MS` timer and `PUBLIC_TEXT.slowCheck` (4.4), time-budget slices (4.3); test 7 |
| Neither path runs: https message, no generic error, answers kept | `PowUnsupportedError` → `pow_unsupported` → notice, phase stays `form`; test 8 |
| No new SHA-256 dependency | None added; `sha256.ts` reused and made incremental (3, 4.2) |
| Measured PoW time on UAT Chrome, raise if median > 10 s | Manual: DevOps/tester solves 20 sessions at 16 bits on UAT over http and writes the median and p95 on the card. Expected about 0.2-1 s on a desktop (2.4). The builder adds no timing code to production. A console snippet for the tester is fine: `performance.now()` around `solvePow` |

## 8. Risks

- **The origin precondition** (2.2) can make AC1 fail on UAT whatever the client does. That is config, not code;
  DevOps adds the LAN origin to `AOM_EXTRA_ORIGINS` if it is missing.
- **AC3 wording vs the measurement** (4.1). The fallback design is ready if the owner wants a subtle PoW.
- **Refactor of verified code.** Keep the compression body as it is, and run the NIST and uneven-chunk tests before
  and after.
- **Fake timers and the PoW**: in test 7 mock `solvePow`. Do not run a real PoW under fake timers (its
  `setTimeout(0)` yields would never fire).
- **Worker message shape change**: update `solvePow`'s `onmessage` together with the worker. An old cached worker
  asset cannot occur, because Vite hashes the asset name.
