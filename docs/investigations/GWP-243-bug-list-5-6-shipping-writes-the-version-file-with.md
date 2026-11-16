# GWP-243: the release commit drops the version file's final newline, and nothing checks the files it writes

## 1. Question

Release 1.9.0 failed lint on main. The release commit (`52518a1b chore(release): 1.9.0`) rewrote
`apps/runner/src/version.ts` without its final newline, and `biome check .` refused it. Two questions:

1. Why does the ship lose the final newline, and how do we make every file it writes byte-preserving apart from the
   version value?
2. How does the ship find the target repository's formatter/linter, so it can run it on only the files it wrote before
   the commit is pushed, fix what can be fixed safely, and fail cleanly (retryable, nothing pushed) otherwise?

## 2. Findings

### 2.1 Root cause of the lost newline (not in `replaceComponentVersion`)

`replaceComponentVersion` (`packages/shared/src/repo/component-rules.ts:251`) is already byte-preserving. It slices
`text` around the capture group's indices (`FLAGS = 'md'`, so `m.indices` is set) and keeps every other byte.

The bytes are lost **before** it is called:

- `commitRelease` (`apps/runner/src/git/release-ship.ts:225`) takes the file text from
  `facts.components[].contentAtHead`.
- `componentFactsAt` → `fileAt` (`apps/runner/src/git/release-facts.ts:35-41`) reads it with
  `git show <sha>:<path>` through the shared `git()` helper.
- `git()` (`apps/runner/src/git/git.ts:180`) calls `execa` without `stripFinalNewline: false`. execa's default
  **strips the final newline** from stdout (one `\n`, or `\r\n`).
- So `contentAtHead` is the file without its last line ending, and `writeFile(join(wt, rule.versionFile), out.text)`
  writes it back that way.

The 1.9.0 diff confirms it: `-export const RUNNER_VERSION = '0.1.75';` / `+... '0.1.76';` plus
`\ No newline at end of file`.

The existing tests did not catch it. `apps/runner/test/release-ship.test.ts` reads the result through `sh(...)`, which
trims, so the missing newline is invisible there.

I probed execa 10.2.1 (the runner's version) on a file with a UTF-8 BOM and CRLF:

| call | stdout |
|---|---|
| default | `﻿<Version>1.0.0</Version>` (final `\r\n` gone) |
| `stripFinalNewline: false` | `﻿<Version>1.0.0</Version>\r\n` (byte-exact, BOM kept) |

So a single option fixes the bytes, including CRLF and BOM files. Inner line endings were never affected.

### 2.2 The CHANGELOG

The ship reads CHANGELOG.md from the integration worktree with `readFile`, not through `git()`, so it is not hit by the
execa issue.

- `releaseChangelog` (`changelog-rewrite.ts:89`) keeps the original EOL style (`eol`) and appends one `eol` only when the
  original had a final newline (`trailing`).
- `newChangelog` ends with exactly one `\n`. `composeReleaseSection` trims its parts, and the array ends with `''`.

Two gaps against the ACs:

- An original CHANGELOG **without** a final newline is written without one. AC2 requires exactly one final newline on
  the CHANGELOG the ship writes.
- An original that ends in several blank lines keeps them, so the file does not end with exactly one newline.

A smaller issue: `commitRelease` pushes `'CHANGELOG.md'` into `written` even when `releaseChangelog` answered
`already` (nothing written). This is unreachable today (step 2 of `shipLocked` returns earlier on the same tip), but
the format check must only get files that were really written.

### 2.3 Ordering in `shipLocked`, and what "retryable" already means

`shipLocked`:

1. prepare (fetch, tag refusal)
2. already released → `alreadyDone`
3. a kept, unpushed commit → push it
4. `withIntegrationWorktree(... commitRelease ...)`
5. `pushCommit`

`commitRelease` writes the files, runs `git add`, refuses unexpected changes, commits, and only then sets the kept ref
`refs/guildwise/release/<version>`.

A failure returned from `commitRelease` **before** `git commit` therefore:

- leaves no commit and no kept ref;
- pushes nothing and tags nothing;
- lands on the server as `applyReleaseShipResult` → `appendReleaseFailure` ("Release x stopped at <step>", with Retry
  and Dismiss). For a `release.ship` step, Retry sends the stored payload again and the runner starts over from a fresh
  worktree.

This is exactly the retry state the card asks for. The check must run between the writes and `git add`/`git commit`.
No server change is needed.

`notices` from a successful ship are copied into the "Release x prepared" desk item body (`ship.ts:404-411`), so a notice
is a visible "result/log" record.

### 2.4 What already exists for finding lint/format commands

- **Confirmed `check` suites** (`IntegrationSuiteSchema`, kind `check`, with an optional `fix`), set per project and
  proposed by `apps/runner/src/checks/detect.ts`.
  - They are **whole-repository** argv lines (`pnpm lint` = `biome check .`, fix `pnpm format`), with no files token,
    so they cannot be limited to the written files.
  - `fix` would reformat the whole repository, which the card forbids.
  - They also need the repository's dependencies installed in the worktree. The release integration worktree is a
    bare `git worktree add` with no `node_modules`.
- **`detect.ts` step 3** already recognises the usual tool configs (biome.json/jsonc, prettier configs, ruff,
  `dotnet format`). The same idea works here, with file-scoped commands.
- **Release prep** (`release-docs-prep-*.ts`) runs repository programs in an integration worktree through an injected
  `exec` with the toolchain PATH, unsandboxed: release-branch code is trusted. It runs `pnpm install` first, which takes
  minutes and needs a warm store or the network. That is too heavy for a two-file format.

### 2.5 Biome behaviour on named files (probed with the repo's biome 2.6.6 and GuildwiseHQ's `biome.json`, in a scratch copy)

- `biome check --no-errors-on-unmatched --files-ignore-unknown=true apps/runner/src/version.ts CHANGELOG.md` on a
  version file without a final newline: exit 1, "Formatter would have printed … + (newline)".
- With `--write`: the final newline is added. Output: "Fixed N files".
- `CHANGELOG.md` is excluded by GuildwiseHQ's config (`!**/*.md`). With `--no-errors-on-unmatched` it is skipped
  silently ("Checked 0 files", exit 0). **Without the flag biome exits 1** ("No files were processed in the specified
  paths"), so the flag is required.
- An unfixable lint error (`1 == 2`: an unsafe-only fix, plus `noConstantCondition`): `check --write` applies the safe
  fixes, exits 1, and prints `path:line:col rule` for each remaining error. A follow-up `check` (no write) exits 1 with
  the same diagnostics.
- Biome's formatter uses the configured `lineEnding` (default `lf`). A CRLF file in a repository whose biome config says
  `lf` would be rewritten to LF by the fix. In that case the repository's own lint already fails on that file; see risk
  R3.

## 3. Options for discovering the check command

| # | Option | For | Against |
|---|---|---|---|
| A | The project's confirmed `check` suites (and their `fix`) | Owner-confirmed; already in the product | Whole-repo commands: cannot scope to files; `fix` reformats the repo; needs `node_modules` in the worktree (an install); a project without suites never gets a check |
| B | Add a `{files}` variant to `check` suites (like `handoffCmd` of unit suites) | Owner-controlled and generic | New settings field + UI + server/protocol change; every project must configure it before it helps; GuildwiseHQ still needs setting up; larger than this bug |
| C | **Detect a known file-scoped formatter from the repository config at the release tip** (biome, prettier), run the repository's own installed binary on the written files | Works today for GuildwiseHQ and any biome/prettier repo with no setup; the command comes from the target repository, not hard-coded; argv can be limited to exact files; no install, no network | Only the tools in the table; a repo whose binary is not installed on the workstation gets a skip (with a notice) |
| D | `pnpm install` in the worktree, then run the repo's `format` script | Exact tool version | Minutes per ship, needs a warm store or network, node-only, runs install scripts; the `format` script is whole-repo anyway |

**Decision: C.** Biome is checked first, then prettier. The binary is resolved from the runner's own clone of the
repository, then from the toolchain PATH. A repository with neither a known config nor an installed binary is skipped
with a notice, and part 1 still guarantees the bytes. B is a good follow-up if owners ask for other tools (ruff,
`dotnet format`, eslint); I suggest it as a backlog item, not part of this card.

## 4. Design

### 4.1 Part 1: byte-preserving writes

**a) `apps/runner/src/git/git.ts`.** Add an opt-in option. The default is unchanged, so no other caller changes:

```ts
export interface GitOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Keep stdout byte-exact: no stripping of the final newline (file contents read with `git show`). */
  keepFinalNewline?: boolean;
}
// in git(): execa('git', hardenedGitArgs(args), { ..., stripFinalNewline: !opts.keepFinalNewline })
```

**b) `apps/runner/src/git/release-facts.ts` `fileAt`.** Use `git(repoPath, ['show', `${sha}:${path}`], { keepFinalNewline: true })`.
`contentAtHead` and `contentAtTag` become the exact blob text.

- Every reader stays correct: `componentBumps` and the server's proposal both call `readComponentVersion`. With the `m`
  flag, `$` still matches before a final `\n`.
- The protocol cap (262 144) is unchanged.

**c) `commitRelease`.** It keeps writing `out.text` (now byte-exact). Add a guard, so a future regression fails loudly
instead of shipping a broken file:

```ts
// the only change may be the version value: same length delta and the same final line ending
// (compare the ending kind, not the last characters: a VERSION file may end with the version itself)
const eolOf = (s: string) => (/\r\n$/.test(s) ? 'crlf' : /\n$/.test(s) ? 'lf' : 'none');
if (out.text.length - text.length !== out.to.length - out.from.length || eolOf(out.text) !== eolOf(text))
  return fail('components', `${rule.versionFile}: the bump would change more than the version`);
```

No newline is **added** to a version file that had none. If the repository's formatter wants one, part 2 adds it. That
is the card's "unless the lint step requires it".

**d) `packages/shared/src/release/changelog-rewrite.ts`.** The CHANGELOG is text the ship authors, so it always ends
with exactly one line ending:

- `releaseChangelog`: drop trailing empty lines from `out`, then `out.join(eol) + eol`. This applies whether or not the
  original had a final newline. CRLF stays CRLF (`eol`), and no blank line is ever added at the end. Update the doc
  comment: "…every line outside the Unreleased block stays as it was, except that the file ends with exactly one line
  ending".
- `newChangelog`: already correct. Add a test.

**e) `commitRelease`.** Push `'CHANGELOG.md'` into `written` only when the file was really written (`rewritten`, or
new).

### 4.2 Part 2: format check on the written files

New module **`apps/runner/src/git/release-format.ts`**:

```ts
export type ReleaseExec = (cmd: string, args: string[], o: { cwd: string; timeoutMs: number })
  => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>; // same shape as DocsPrepExec

export interface ReleaseFormatInput {
  worktree: string;          // the integration worktree (= release tip)
  files: string[];           // repo-relative, exactly what the ship wrote (deduped)
  repoPath: string;          // the runner's clone: where the repo's own node_modules/.bin lives
  pathDirs: string[];        // toolchain PATH dirs, then process PATH
  exec?: ReleaseExec;        // absent: skipped ("this runner cannot run programs for the ship")
}

export type ReleaseFormatOutcome =
  | { state: 'skipped'; reason: string }
  | { state: 'passed'; tool: string; commands: string[]; files: string[]; fixed: string[] }
  | { state: 'failed'; tool: string; commands: string[]; files: string[]; failing: string[]; output: string };

export function detectReleaseFormatter(worktree: string): FormatterSpec | null;
export async function formatReleaseFiles(input: ReleaseFormatInput): Promise<ReleaseFormatOutcome>;
```

**Detection table**, read from the worktree root, which is the release tip on the trusted working branch. The first
match wins:

| tool | detected by | fix argv | verify argv |
|---|---|---|---|
| biome | `biome.json` or `biome.jsonc` | `check --write --no-errors-on-unmatched --files-ignore-unknown=true --max-diagnostics=none --colors=off <files>` | `check --no-errors-on-unmatched --files-ignore-unknown=true --max-diagnostics=none --diagnostic-level=error --colors=off <files>` |
| prettier | `.prettierrc`, `.prettierrc.{json,json5,yaml,yml,toml,js,cjs,mjs}`, `prettier.config.{js,cjs,mjs,ts}`, or a `"prettier"` key in the root package.json | `--write --ignore-unknown --no-color <files>` | `--check --ignore-unknown --no-color <files>` |

Rules:

- **`<files>`**: each written path as `./<path>`. The `./` prefix keeps a path from ever being read as an option. Paths
  are already safe repository paths (`isSafeProjectPath`).
- **Binary resolution** (never `npx`, never an install, never the network):
  1. `<repoPath>/node_modules/.bin/<tool>` (on Windows also `<tool>.cmd`);
  2. the first `<dir>/<tool>` in `pathDirs` that exists.

  No binary → `skipped`, reason: `biome.json is in the repository but no biome program was found in <repoPath>/node_modules/.bin or on the toolchain PATH`.
- **No config** → `skipped`, reason: `the repository has no biome or prettier configuration`.
- **Run order**: `cwd` = the worktree, so the tool reads the tip's config. Run fix (timeout 2 min), then verify (timeout
  2 min).
  - The **verify exit code decides**: 0 → `passed`; non-zero, a timeout, or a spawn error → `failed`.
  - The fix pass's own exit code is ignored, because biome exits 1 when unfixable errors remain and verify reports them.
- **`fixed`**: the written files whose bytes changed between before-fix and after-fix (read each file before and after).
- **`failing`**: the written files named in the verify output. If none is named, all written files.
- **`output`**: `stripAnsi` (from `checks/attribute.ts`) of stdout+stderr of the verify run, last ~2500 characters.

**Wiring in `commitRelease`**, after the CHANGELOG write and **before** `git add`:

```ts
const files = [...new Set(written)];
const fmt = await formatReleaseFiles({ worktree: wt, files, repoPath: input.repoPath,
  pathDirs: input.toolPathDirs ?? [], exec: input.exec });
if (fmt.state === 'failed')
  return fail('commit',
    `the ${fmt.tool} check failed on ${fmt.failing.join(', ')}; nothing was committed or pushed. ` +
    `Fix it on ${p.workingBranch}, then Retry.\n$ ${fmt.commands.at(-1)}\n${fmt.output}`, { notices });
notices.push(fmt.state === 'skipped'
  ? `Format check skipped: ${fmt.reason}.`
  : `Format check: ${fmt.tool} ran on ${fmt.files.join(', ')} (${fmt.commands.join(' ; ')}): passed` +
    (fmt.fixed.length ? `; it fixed ${fmt.fixed.join(', ')}` : '') + '.');
```

- Each notice is capped at 500 characters (`ReleaseShipResultSchema.notices`). Shorten the file list ("and N more") and
  print the binary by its base name, not the full path.
- `fail()` already trims the error to 3500 characters (the schema cap is 4000).
- Also log the same line through the runner's logger, if `commitRelease` has one in reach (optional).
- The existing `git add -- ...written`, followed by the "unexpected changes in the release worktree" refusal, still
  runs after the check. A formatter that touched any other file stops the ship there (step `commit`, nothing pushed).
  That enforces "never reformats other files".
- **Step name**: the failure uses the existing step `commit`, not a new enum value. `ReleaseShipStepSchema` is shared
  with the server and parsed there with `safeParse`, so a new value would make an older server drop the whole result.
  Keeping `commit` means no protocol or capability change.

**`ReleaseShipInput`** gets two optional fields: `exec?: ReleaseExec` and `toolPathDirs?: string[]`.

**`apps/runner/src/runner.ts`** (the `release.ship` branch, ~line 2563) passes both, built like the docs-prep `exec` at
~2605:

```ts
exec: async (cmd, args, o) => {
  const tc = this.toolchains.resolve();
  const r = await this.exec.run(cmd, args, { cwd: o.cwd, timeoutMs: o.timeoutMs,
    env: { ...tc.env, PATH: [...tc.pathDirs, process.env.PATH ?? ''].join(delimiter) } });
  return { ...r, timedOut: false };
},
toolPathDirs: [...this.toolchains.resolve().pathDirs, ...(process.env.PATH ?? '').split(delimiter)],
```

Both run under the same `withRepoLock` and inside the same `withIntegrationWorktree` (`commitRelease` is already there).
The ship makes no extra push.

Paths that skip the check: the `alreadyDone` path and the kept-commit resume path (steps 2/3). Their commit was made
earlier, by a ship that ran the check (or by an older runner). This is correct and needs no change.

### 4.3 Data model / API

- No database, event, server or web change.
- No change to `ReleaseShipPayloadSchema`, `ReleaseShipResultSchema` or `ReleaseShipStepSchema`.
- No new capability: an older server shows the new notices and errors as text, as it does today.

### 4.4 Docs (builder updates)

- `docs/RUNNER.md` → `### release.ship`:
  - step 3: the version file is read byte-exact (final newline, CRLF, BOM kept);
  - step 4: the CHANGELOG always ends with exactly one line ending;
  - a new step between 4 and 5, **format check**: detection table, binary lookup, fix then verify, skip and failure
    behaviour, the notice.
- `docs/USER-GUIDE.md`, release section: one sentence saying the release commit runs the repository's biome or
  prettier on the files it changes, and what a "stopped at commit" with a format error means (fix on the working branch,
  then Retry).

### 4.5 Runner version

Do not bump `RUNNER_VERSION` by hand. The Ship release item raises it in the release commit when `apps/runner/**`
changed since the last tag (docs/RUNNER.md "Releasing").

## 5. Acceptance criteria → design → test

| AC | Met by | Test |
|---|---|---|
| 1. A version file ending in `\n` still ends with exactly one `\n` and differs only in the version | 4.1 a/b (byte-exact `fileAt`), c (guard) | release-ship.test.ts: ship, then read the blob **untrimmed** (`git cat-file blob develop:apps/runner/src/version.ts` via `execFileSync`, not `sh`); compare with the original and the version replaced. shared: `replaceComponentVersion` on `\n` input. runner: `componentFactsAt` returns `contentAtHead` ending in `\n` (release-facts.test.ts) |
| 2. The CHANGELOG ends with exactly one newline | 4.1 d | shared: `releaseChangelog` on input with no final newline, one, and `\n\n\n` → exactly one; `newChangelog` → one. Ship test: CHANGELOG blob ends with one `\n` |
| 3. No extra blank lines; CRLF stays CRLF | 4.1 a–d | shared: `replaceComponentVersion` on CRLF and on no-final-newline input → unchanged apart from the version; `releaseChangelog` on CRLF → CRLF throughout, one final `\r\n`. Ship test with a CRLF version file and no formatter config → blob is CRLF, final `\r\n` kept |
| 4. The formatter runs on exactly the written files; the result says which command and files | 4.2 | release-format.test.ts with a fake `exec` recording argv: biome config → argv ends with exactly `./apps/runner/src/version.ts ./CHANGELOG.md`; cwd = worktree. Ship test: notice contains the tool, the commands and the files |
| 5. A fixable problem is fixed, in the commit, and the ship succeeds | 4.2 fix → verify, `git add` after the check | Ship test with a fake biome (an executable script in `<clone>/node_modules/.bin/biome` that, given `--write`, appends `\n` to its file arguments and exits 0) on a fixture whose version file has no final newline: the committed blob ends with `\n`; the notice says "fixed …" |
| 6. An unfixable problem fails naming the file and quoting the output; nothing pushed; retryable | 4.2 `failed` → `fail('commit', …)` before `git commit` | Ship test with a fake biome whose verify run prints `apps/runner/src/version.ts:1:1 lint/x  boom` and exits 1: `ok:false`, `step:'commit'`, the error contains the path and `boom`; origin `develop` commit count unchanged; no `refs/guildwise/release/1.4.0`; a second ship with a passing fake biome succeeds (retry) |
| 7. No command → skipped, recorded; the newline guarantee holds | 4.2 skip paths; 4.1 | Ship test with no config: `ok:true`, notice `Format check skipped: …`, and the blob is byte-exact. Also: config present but no binary → skip notice naming where it looked. `exec` absent → skip |
| 8. GuildwiseHQ: `biome check` passes on every written file | 4.1 + 4.2 with the real biome | Unit test that runs the **real** `node_modules/.bin/biome` of this repository: copy GuildwiseHQ's `biome.json` into a temp repo, write `version.ts` without a final newline, call `formatReleaseFiles` with a real exec → `passed`, file fixed, CHANGELOG.md skipped by the config. Skip the test if the binary is absent. Manual/CI: the next patch release's commit passes the `Typecheck and lint` job |
| 9. Existing release-ship and release-docs-prep tests pass | No behaviour change outside `commitRelease`; `pushFastForward` untouched | Full `apps/runner` and `packages/shared` unit suites, `tsc` for shared and runner, `biome check` on the changed files |

## 6. Risks and traps

- **R1. Trimmed test helpers.** `sh()` in the runner test helpers trims output, which is why today's tests miss the
  bug. Read blobs for byte assertions with `execFileSync('git', ['cat-file', 'blob', …])` (or a helper that does not
  trim).
- **R2. `keepFinalNewline` must stay opt-in.** Many callers depend on trimmed stdout (`rev-parse`, `status`, etc.). Pass
  it only in `fileAt`. Consider also passing it in `detectChecksFromRef`'s `git show` (same bug, harmless there), but
  only if the builder wants to; it is out of scope.
- **R3. Formatter and line endings.** A repo whose formatter config enforces `lf` turns a CRLF version file into LF in
  the fix pass. That file already failed the repo's own lint before the ship. The fix is the repo's configured style and
  is reported in the notice ("it fixed …"). AC3's CRLF test runs without a formatter config.
- **R4. Trust.** The formatter is the repository's own program, from the runner's clone or the toolchain, run as the
  runner user and unsandboxed. This is the same trust as Release prep (release-branch code is trusted). A
  `prettier.config.js` executes code from the working branch. That branch holds merged code, as for docs prep. Never use
  `npx` (it would download).
- **R5. Version skew.** The binary comes from the clone's `node_modules`, which may be a different version than the
  tip's lockfile. For formatting a version string and a CHANGELOG this is negligible. A verify failure caused by skew is
  still a clean, retryable stop.
- **R6. Prettier plugins** listed in a config resolve relative to the config. Without `node_modules` in the worktree
  they can fail to load: a retryable stop with prettier's message. This is acceptable for now; option B is the way out
  if it shows up.
- **R7. Windows.** On Windows, `.bin` shims are `.cmd` files. Look for `<tool>.cmd`, and make sure the exec runs them
  (the Executor uses execa without a shell; a `.cmd` needs `shell: true` or `cmd /c`). If this is not trivial, skip with
  a notice on win32 and say so in the handoff.
- **R8. Overlap with GWP-260.** GWP-260 touches `shipLocked`/release-facts. This card only edits `commitRelease`,
  `fileAt` and the `git()` option. Expect a small textual merge at most.

## 7. Out of scope / follow-ups

- Option B (an owner-configured, file-scoped release check, e.g. `{files}` on `check` suites) and more tools (ruff,
  `dotnet format whitespace --include`, eslint `--fix`). I am suggesting these as a backlog item.
- Non-UTF-8 version files: they are decoded as UTF-8 today and would be re-encoded. This is unchanged by this card.
