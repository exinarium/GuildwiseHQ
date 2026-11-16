# GWP-250: handoff check attribution gaps (paths with spaces, code frames under `pnpm -r`)

## 1. Question

The handoff checks attribute every line of a failing check's output to the repository files it names
(`attribute` in `apps/runner/src/checks/attribute.ts`). The result decides whether a builder is refused or whether the
findings are deferred to the tester (E2E-only findings). The 1.5.0 review accepted two gaps:

- (a) a finding whose file path has spaces and no `:line` suffix (a bare path line, an ESLint stylish file header) is not
  matched to its file;
- (b) under `pnpm -r`, every line has a `<package> <script>: ` prefix, so code-frame lines are not recognised. Text in a
  frame (a URL, for example) then counts against the builder even when the finding is in an `e2e/**` file.

What is the smallest change to the attribution step that closes both gaps without changing which checks run, their
exit codes, or any path rule?

## 2. Findings

### 2.1 How attribution works today (`attribute.ts`)

For each line, after `stripAnsi` and `trim()`:

1. `PNPM_PREFIX` (`/^(\S+) [\w:-]+: /`) is matched. Its first group is used only as an extra lookup folder
   (`prefixDir`), and only if that folder exists. The prefix is **never stripped** from the line.
2. `TOKEN` scans the whole line for path-like tokens (no spaces allowed). Each token is turned into candidates
   (worktree-relative, `prefixDir/`, `cwd/`, plain) and checked against `changed`, then `exists`.
3. A line with a hit becomes a `Finding`. A line with no hit that matches `LOCATION` counts as `unattributed`, **unless**
   `CODE_FRAME` (`/^(?:>\s*)?\d*\s*[│|]/`) matches the line.

`CODE_FRAME` (added in c853b9c6 for review item R1) is used **only** to suppress the unattributed count. Frame lines are
still token-scanned.

In `run.ts` (`runHandoffChecks`), a builder whose findings are all owed (E2E) is deferred only when `unattributed === 0`
and the output is complete. Otherwise the check blocks with "N diagnostic lines name no file of the repository the
runner could match".

### 2.2 What actually happens (current code, run on a scratch copy)

Files that exist: `src/a.ts`, `src/my file.ts`, `e2e/tests/x.spec.ts`, `e2e`, `apps/web`, `apps/web/src/my file.ts`.

| Case | Output | Findings (paths) | unattributed |
|---|---|---|---|
| a1 bare path with spaces | `src/my file.ts` | none | 0 |
| a2 stylish header, absolute | `/work/wt/src/my file.ts` + `  12:3  error …` | none | 0 |
| a4 spaces + line | `src/my file.ts:3:1 lint/y` | none | 1 |
| a6 stylish under pnpm | `apps/web lint: /work/wt/apps/web/src/my file.ts` | none | 0 |
| b2 frame with port, no prefix | `> 12 │ page.goto("http://127.0.0.1:3000/login")` | e2e only | 0 |
| b3 same frame under pnpm | `e2e lint:   > 12 │ page.goto("http://127.0.0.1:3000/login")` | e2e only | **1** |
| b4 frame names a file, no prefix | `> 12 │ // see src/a.ts:12` | e2e + **src/a.ts** | 0 |
| b5 same under pnpm | `e2e lint:   > 12 │ // see src/a.ts:12` | e2e + **src/a.ts** | 0 |
| b7 ESLint codeframe under pnpm | `apps/web lint: > 3 \| const u = "https://example.com:8443/x";` | none | **1** |
| r1 Biome diff context line | `12 12 │ const u = "http://127.0.0.1:3000";` | none | **1** |
| m1 mypy | `src/a.ts:3: error: Incompatible types` | src/a.ts | 0 |

What this shows:

- **(a) is a silent miss, not just a cosmetic one.** a1/a2/a6 produce no finding *and* no unattributed count. If the same
  output also has an E2E finding, the builder's own finding in `src/my file.ts` is invisible and the check is
  **deferred**: the builder gets through with a real problem in its own file. Alone, the check ends as "failed without
  naming a file" (error). Both are wrong.
- **(b) has two mechanisms:**
  1. A URL with a port (`127.0.0.1:3000`, `example.com:8443`) matches `LOCATION`. Under the prefix, `CODE_FRAME` does not
     match, so the line counts as unattributed and deferral is refused (b3, b7). This is the reported bug.
  2. Frame lines are token-scanned with or without a prefix, so a file named in frame *text* becomes a finding (b4, b5).
     If it names a builder-owned file, the builder is refused for text inside an E2E file's code frame. The card says
     frame text must never be attributed, so this is closed too.
- Plain `https://host/path` URLs without a port do not produce tokens today: `s://…` is treated as an absolute path and
  dropped. The real URL problem is the port (`LOCATION`) and the path part after a port (`3000/src/a.ts` becomes a
  relative token candidate).
- Biome diff frames (`12 12 │`, two line-number columns) are not matched by the current `CODE_FRAME` either (r1).
- **Trap:** `PNPM_PREFIX` also matches location lines from mypy (`src/a.py:3: error: …`) and gcc/clang
  (`src/a.c:3:5: error: …`): group 1 is `src/a.py:3:`. Stripping that "prefix" unconditionally before token scanning
  would delete the path and break those findings. Any stripping must reject a group 1 that ends in `:` or looks like a
  location.

### 2.3 Tests that exist

- `apps/runner/test/check-attribute.test.ts`: pure unit tests on `attribute` (Biome, tsc, pnpm prefix folder, stylish
  absolute header, Prettier, ruff, dotnet, ANSI, URL line, caps).
- `apps/runner/test/handoff-checks-offline.test.ts`, `describe('judging with the role scope')`: calls `runHandoffChecks`
  directly with a builder scope (`scopeOf('builder', true)`, `e2eGlobs: ['e2e/**']`). It has the R1 code-frame case
  (deferred) and S4 (`src/my file.ts:3:1` where the file does **not** exist, so it blocks as unattributed). This is the
  natural home for the handoff-level cases. (The graph note "no test reaches runHandoffChecks directly" is out of date.)
- `apps/runner/test/handoff-checks.test.ts`: full harness (scripted adapter, mock server). It has the E2E-deferred case
  at "a failing E2E test file on the card branch is deferred…".

## 3. Options

| | Option | For | Against |
|---|---|---|---|
| A | Strip the pnpm prefix from every line in `run.ts` before calling `attribute` | One place | Loses `prefixDir` (the package folder is the only way to resolve `src/x.ts` under `apps/server typecheck:`); mypy/gcc trap; touches `run.ts`, which the card wants left alone |
| B | **In `attribute`: compute a prefix-free `body` (guarded), skip code-frame lines whole on `body`, mask http(s) URLs, and try the whole spaced path on `body` before token scanning** | Local to `attribute.ts`; keeps `prefixDir`; works for any linter; easy to unit test | Slightly more logic per line |
| C | Hard-code linter formats (ESLint stylish parser, tsc parser) | Precise | Against the card ("independent of the linter", "no hard-coded package names"); large |
| D | Ignore lines containing URLs entirely | Tiny | Suppresses input instead of recognising it; a finding line can contain a URL |

**Recommendation: B.**

## 4. Design

All changes are in `apps/runner/src/checks/attribute.ts`. `run.ts` and `supervisor.ts` do not change. No new dependencies.

### 4.1 Constants

```ts
// unchanged
const PNPM_PREFIX = /^(\S+) [\w:-]+: /;

/**
 * A source code frame line under a diagnostic, after any `pnpm -r` prefix: `> 12 │ code`, `13 | code`, Biome diff lines
 * (`12 12 │`, `   12 │ + x`), the gutter under them (`│   ^^^`, `|     ^`), or a bare marker line (`^^^`, `~~~`). It shows
 * code: nothing in it is a file reference or a diagnostic location.
 */
const CODE_FRAME = /^(?:>\s*)?[\d\s]*[│|]|^[\^~]+(?:\s|$)/;

/** An http(s) URL: never a file reference or a diagnostic location (`127.0.0.1:3000` is not `file:line`). */
const WEB_URL = /\bhttps?:\/\/\S*/gi;

/** The location tail after a path: `:12`, `:12:3`, `(12,3)` and the rest of the line. */
const LOC_TAIL = /(?::\d+(?::\d+)?|\(\d+,\d+\))(?:[:\s].*)?$/;
/** Ends like a file name with an extension. */
const PATH_END = /\S\.[A-Za-z0-9]{1,8}$/;
```

The `CODE_FRAME` change (`\d*\s*` to `[\d\s]*`, plus the marker alternative) is a widening. Every line the old pattern
matched still matches.

### 4.2 Loop body (sketch)

```ts
for (const raw of stripAnsi(output).split(/\r?\n/)) {          // stripAnsi still first (AC7)
  const line = raw.trim();
  if (!line) continue;
  const pm = PNPM_PREFIX.exec(line);
  const prefix = pm?.[1];
  const prefixDir = prefix && o.exists(clean(prefix)) ? clean(prefix) : null;   // unchanged
  // `<package> <script>: ` from pnpm -r, not a `file:line: error:` location (mypy, gcc)
  const isPnpmPrefix = !!pm && !pm[1].endsWith(':') && !LOCATION.test(pm[1]);
  const body = isPnpmPrefix ? line.slice(pm[0].length).trim() : line;
  if (CODE_FRAME.test(body)) continue;                         // (b): a frame never attributes, never counts
  const text = line.replace(WEB_URL, ' ');                     // (b): URLs are not paths or locations
  ...
  // (a): a line that is one path with spaces (bare, stylish header, or with a location tail)
  const whole = body.replace(WEB_URL, ' ').trim().replace(LOC_TAIL, '');
  const wholeHit = whole.includes(' ') && PATH_END.test(whole) ? locate(whole) : null;
  if (wholeHit) { record(wholeHit) }                           // and skip the token scan for this line
  else for (const m of text.matchAll(TOKEN)) { record(locate(m[0])) }   // unchanged behaviour
  ...
  if (!hitIntroduced && !hitElsewhere && LOCATION.test(text)) unattributed++;  // CODE_FRAME already handled above
}
```

- Move the existing candidate logic (worktree slice, `prefixDir/`, `cwd/`, plain, then `changed` before `exists`, and the
  `..` exclusion) into a local helper, for example
  `locate(token): { path: string; changed: boolean } | null`. Use it for both the whole-path candidate and each token,
  so the two cannot drift apart. Do not call it `resolve`, so it does not shadow anything imported in the file later.
- The whole-path candidate is only tried when the path part **contains a space**. A path without spaces goes through the
  token scan exactly as today, which keeps AC2 tight.
- When the whole-path candidate finds no file, the line falls back to today's token scan. So a spaced line that names no
  repository file behaves exactly as before. In particular S4 (`src/my file.ts:3:1` with no such file) stays
  unattributed and still blocks.
- Keep `shown`, the `findings` map, `introduced`/`elsewhere`, caps and `incomplete` exactly as they are.
- Update the `unattributed` doc comment on `Attribution`. "A path with spaces" is no longer a cause when the file exists;
  it is when the file does not.

### 4.3 Behaviour after the change (same table as 2.2)

| Case | After |
|---|---|
| a1, a2, a6 | attributed to `src/my file.ts` / `apps/web/src/my file.ts` |
| a4 (file exists) | attributed to `src/my file.ts` (was unattributed; see note) |
| a4 (file missing, S4) | unattributed, as before |
| b2, b3, b7, r1 | frame line skipped: no finding, unattributed 0 |
| b4, b5 | frame line skipped: only the E2E finding remains |
| m1 mypy, gcc | unchanged (the prefix guard rejects `src/a.py:3:`) |
| all existing unit tests | unchanged |

Note on a4: the card lists "paths with spaces that do carry a line number" among forms that "still work". Today they
are never matched (the tail token `file.ts` is looked up instead). The design matches them when the spaced file exists
and otherwise leaves them exactly as before. The existing test (S4) passes unchanged. This is the stated intent of the
card ("matching must still work"), and it can only move a line from "unattributed (blocks)" to "attributed to its real
file". A builder-owned file still blocks. The builder should mention this in the handoff.

### 4.4 Pass/fail is unchanged

`judge` uses the exit code first: exit 0 is always passed, and a non-zero exit is never passed. The fix changes only
which findings exist and the unattributed count. One edge case: a check whose *only* "finding" was a file named inside a
code frame now has `total === 0`, so it ends as `error` ("failed without naming a file") instead of `failed`. Both block,
and the exit code is untouched.

## 5. Acceptance criteria to design

| AC | How it is met | Test |
|---|---|---|
| 1 Spaced path, no line number: bare and stylish header | Whole-path candidate on `body` (4.2) | unit: bare `src/my file.ts`; stylish relative and absolute (`worktree`) header + `  12:3  error …`; stylish under `apps/web lint: ` |
| 2 Existing forms unchanged | Whole-path only when the path has a space; otherwise the unchanged token scan; existing tests untouched | existing `check-attribute.test.ts` and offline tests unchanged; new: spaced + `:3:1` with file missing is still unattributed; mypy `src/a.ts:3: error: x` and gcc `src/a.ts:3:5: error: x` still attributed |
| 3 Frames skipped under `pnpm -r` | Guarded prefix strip to `body`, `CODE_FRAME.test(body)`, then `continue` | unit: `> 12 │`, `12 \|`, `│   ^^^`, `\|     ^`, `12 12 │` each with `e2e lint: ` and `apps/web lint: ` prefixes give no finding and unattributed 0 |
| 4 URL in frame never attributed | Frame skip + `WEB_URL` mask | unit: frame with `https://example.com/x`, `https://example.com:443/`, `http://127.0.0.1:3000/src/a.ts` (with `src/a.ts` existing), with and without prefix: no finding, unattributed 0 |
| 5 Builder not refused for an E2E frame URL; refusal names no URL file | `runHandoffChecks` defers (unattributed 0, findings only E2E) | offline: worktree `['src/a.ts','src/b.ts','e2e/tests/x.spec.ts']`, check echoes `e2e lint: tests/x.spec.ts:12:3 lint/x` + prefixed frame with a URL; expect `status: 'deferred'`, `blocking: []`, `owed` contains `e2e/tests/x.spec.ts` |
| 6 Real owned finding still blocks, with and without prefix | Non-frame lines unchanged; a spaced owned file is now seen | offline: same output plus `apps/web lint: src/b.ts:1:1 lint/x` (or unprefixed `src/b.ts:1:1`): `status: 'failed'`, refused, refusal contains `src/b.ts`, no URL-derived path; unit: E2E header + owned spaced file (`src/my file.ts`) → not all-owed |
| 7 ANSI does not break either fix | `stripAnsi` still runs first on the whole output | unit: cases AC1 and AC3 with colour codes around the prefix, the gutter and the path |

## 6. Files

- `apps/runner/src/checks/attribute.ts`: constants and loop as in 4.1/4.2 (about 30-40 changed lines).
- `apps/runner/test/check-attribute.test.ts`: new cases only (add `src/my file.ts`, `apps/web/src/my file.ts`,
  `e2e/tests/x.spec.ts`, `e2e`, `apps/web` to the `files` set; this does not change existing expectations, but run them).
- `apps/runner/test/handoff-checks-offline.test.ts`, in `describe('judging with the role scope')`, next to R1: the AC5
  and AC6 handoff-level cases (direct `runHandoffChecks`, real `sh -c echo` output, builder scope).
- `apps/runner/test/handoff-checks.test.ts`: one harness-level case, as the card's test plan names this file. A builder
  hands off with a check that echoes the pnpm-prefixed E2E finding and URL frame: accepted, check `deferred`, owed by the
  tester. Model it on "a failing E2E test file on the card branch is deferred…". If the harness makes the prefixed `e2e`
  folder awkward, put the folder in the worktree with `mkdir -p e2e/tests` as that test does.
- No change to `run.ts`, `supervisor.ts`, the what's-new entry (`2026-11-05-builder-checks.md` does not describe these
  limits), `apps/server`, `packages/shared`, or `guildwise-cloud`.

## 7. Risks and limits

- **mypy/gcc false prefix**: guarded (`endsWith(':')` / `LOCATION`). Cover it with a test.
- **Over-broad frame match**: a line whose body starts with `|`/`│` (a markdown-style table) is now skipped for tokens
  too. The old pattern already exempted such lines from the unattributed count. No supported linter prints a finding
  that way, so the risk is low.
- **Regex cost**: `LOC_TAIL` and `PATH_END` are anchored and linear. There is no lazy `.*?` over long lines.
- **Not covered (unchanged limits)**: a spaced path in the middle of a sentence (`Found 2 errors in src/my file.ts`);
  Prettier `[warn] src/my file.ts` (the `[warn] ` marker stays in the whole-path candidate, so it falls back to tokens);
  tsc `--pretty` frames without a gutter (not printed when output is piped, as it is here); pnpm prefixes that use a
  package *name* instead of its folder.
- **Run**: `pnpm --filter @aom/runner exec vitest run test/check-attribute.test.ts test/handoff-checks-offline.test.ts
  test/handoff-checks.test.ts` (these spawn only `sh` and a local mock server, with no network), then
  `pnpm --filter @aom/runner typecheck` and `pnpm exec biome check apps/runner`.
