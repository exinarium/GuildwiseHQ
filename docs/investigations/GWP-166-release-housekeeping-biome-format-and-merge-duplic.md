# Release housekeeping: biome format and duplicate CHANGELOG headings (release/1.6.0)

## Question

The 1.4.0 release reviews asked for two housekeeping steps before the release PR:

1. Run the repository formatter (`pnpm format`, biome) so that `biome check` passes. The reviews named import order in `apps/runner/src/runner.ts` and over-width lines in `packages/shared/src/protocol/runner.ts` and `apps/server/src/runner-gateway/handlers.ts`.
2. Merge the duplicate `### Added` headings in the `## [Unreleased]` section of `CHANGELOG.md`.

The release line is now `release/1.6.0`. Do these steps still apply there?

## Findings

### Re-check after GWP-165 landed (2026-11-08, at `02d3b1c6`)

This section replaces the "clean" verdict of the first pre-check below for formatting. The CHANGELOG verdict still holds.

- **Formatting: one finding, not from GWP-165.** `biome check --linter-enabled=false .` (biome 2.5.15, unchanged `biome.json`) checked 3427 files and reports **1 format error**: an over-width line in `apps/web/src/test/release-docs-prep.test.tsx:374`:

  ```ts
  expect(within(hq).getByTestId('guide-output-pdf-date')).toHaveTextContent('PDF dated 2026-11-08, release 1.5.0');
  ```

  biome wants the string argument on its own line:

  ```ts
  expect(within(hq).getByTestId('guide-output-pdf-date')).toHaveTextContent(
    'PDF dated 2026-11-08, release 1.5.0',
  );
  ```

  It came in with `19db9b4c GWP-160: take the PDF guide footer and cover date from the release` (merge `58e62bbf`), not with GWP-165. Because it is an error, **`pnpm lint` (`biome check .`) now exits 1** on the working branch, so CI's lint step fails until it is fixed. That is exactly what R1 is for, so the build now has a real one-file formatting diff instead of no code diff.
- The GWP-165 files (`apps/runner/src/runner.ts`, `apps/runner/src/git/release-ship.ts`, `apps/server/src/release/ship.ts`, `apps/server/src/release/ship-stuck.ts`, `apps/server/src/commands/desk.ts`, `apps/server/src/dispatcher/phases.ts`, `apps/server/src/runner-gateway/handlers.ts`, `packages/shared/src/protocol/runner.ts` and its tests) report **0 format or import-order findings**. So do the three files the review named.
- `biome.json` and the biome version are unchanged since `d0314804`. `package.json` gained only a `test:guide` script (GWP-160).
- Running biome inside the sandbox also prints `.mcp.json internalError/io Permission denied`. `.mcp.json` is an untracked file of the local checkout, not part of the repository and not present in CI; ignore that line (do not add it to `biome.json`).
- **CHANGELOG: still no repeated heading.** GWP-165 added one bullet under the existing `### Fixed` in Unreleased and touched no released section. Other merges since the pre-check added `### Added` (upload scan) and `### Security` (trusted proxy). Unreleased now reads: `Runner 0.1.70.`, then `### Added` (1), `### Security` (1), `### Changed` (2), `### Fixed` (2), each heading once. No section in the file repeats a heading.

### First pre-check (2026-11-08, at `d0314804`, before GWP-165 and GWP-160 landed)

#### F1 Formatting: clean at that time

- Tool: `@biomejs/biome` 2.5.15, the same version `pnpm-lock.yaml` pins, run with the repository's own `biome.json`. Root scripts: `lint = biome check .` and `format = biome check --write .`. CI runs `pnpm lint` (`.github/workflows/ci.yml:65`).
- `biome check .` exited 0. It checked 3411 files and reported 4246 warnings and 40 infos, all from lint rules (`noExplicitAny` 3800, `useOptionalChain` 155, `noTemplateCurlyInString` 124, `noUnusedImports` 60, `noUnusedVariables` 46, and others). Warnings do not fail `pnpm lint`, and the card does not cover them ("formatting only, no logic change"; removing unused imports or `any` would be a code change).
- `biome check --linter-enabled=false .` (formatter plus the `organizeImports` assist, which is exactly the scope of this card) reported 0 findings.
- Where the earlier fix came from: `97108739 style: biome format and import order on release/1.5.0` (2026-11-04), then `aab35830`, `16a4b99e` and `924755ca` kept the tree formatted.

#### F2 CHANGELOG Unreleased: no duplicate headings

- Unreleased had one `### Changed` and one `### Fixed`; no `### Added`. The duplicate `### Added` from the 1.4.0 line was released under `## [1.4.0]`, which has a single `### Added`.

### Conclusion

- R1 applies again: one over-width line in `apps/web/src/test/release-docs-prep.test.tsx` makes `pnpm lint` fail. `pnpm format` fixes it; the diff is line wrapping only.
- R2 does not apply: no repeated heading in Unreleased; `CHANGELOG.md` stays untouched.

## Options

| Option | What it does | Pros | Cons |
|---|---|---|---|
| A. Close now, no build | Card closed on the pre-check | No work | Leaves `pnpm lint` failing on the working branch |
| **B. Verify-and-format build (recommended)** | The builder re-runs the checks, runs `pnpm format` because the check has a finding, and leaves the CHANGELOG alone unless a heading repeats by then | Meets every AC; fixes the CI lint failure; catches anything else that lands before the build | One short build shift |
| C. Hand-edit the one line | Same result for this line | — | Misses anything else biome would flag by build time; B is just as small |

## Recommendation and design (option B)

The build is a **formatting-and-changelog-only pass** on the card branch, based on the working branch with GWP-165 merged (it is; refresh with `aom git merge-main` first).

### Steps for the builder

1. Install and check the base:
   - `pnpm install --frozen-lockfile` (needed for biome, typecheck and tests).
   - Before changing anything, record the results of `pnpm lint`, `pnpm exec biome check --linter-enabled=false .`, `pnpm typecheck` and `pnpm test` (unit tests only) as the baseline. Expect `pnpm lint` to exit 1 with the one format error above (plus the `.mcp.json` I/O line if the untracked file is in the checkout). If some tests already fail on the base, note them once and do not fix them.
2. Formatting (R1):
   - Run `pnpm format` (`biome check --write .`, which applies only **safe** fixes: formatting and import order). Expected result: only `apps/web/src/test/release-docs-prep.test.tsx` changes, one line wrapped into three. If more files change, that is fine as long as the changes are formatting only.
   - Do **not** run `--write --unsafe`, and do not fix lint warnings (`noUnusedImports`, `noExplicitAny`, `useOptionalChain` and so on). Those are code changes and outside this card.
   - Do not change `biome.json`.
   - Afterwards `pnpm lint` must exit 0 and the linter-off run must report 0 findings (ignoring the untracked `.mcp.json` I/O line). Check `git diff`: it may contain only whitespace, line wrapping, trailing commas, quote style and import order (`git diff -w --stat` together with a manual read is enough).
3. CHANGELOG (R2):
   - Count the `### ` headings inside `## [Unreleased]` only (from the line `## [Unreleased]` to the next `## [`). Example check: `awk '/^## \[/{s=$0} s=="## [Unreleased]" && /^### /{c[$0]++} END{for(k in c) if(c[k]>1) print c[k], k}' CHANGELOG.md`.
   - Today nothing repeats, so do not touch `CHANGELOG.md`.
   - Only if a heading repeats by the time of the build: move the bullets of the later block under the first heading of that kind, after its existing bullets, keeping wording and relative order, delete the empty later heading and its blank line, keep the existing order of heading kinds. Confirm with `git diff -U0 CHANGELOG.md` that every hunk lies between `## [Unreleased]` and `## [1.5.0]`, and that the bullet count in Unreleased is the same before and after.
4. Re-run `pnpm typecheck` and `pnpm test`. The results must match the baseline.
5. Commit the formatting change with a plain message (for example `Format with biome: wrap an over-width line in the release docs prep test`). A CHANGELOG change, if one was needed, goes in a separate commit. Do not commit unrelated local edits (for example `.env*.example` changes) if they show up in the checkout. The handoff records the AC1 result: formatting had one finding on the working branch (from GWP-160), CHANGELOG had no repeated heading.

### Files

- Changed: `apps/web/src/test/release-docs-prep.test.tsx` (formatting), plus anything else biome's safe fixes touch by build time.
- Not changed: `CHANGELOG.md` (unless a heading repeats by then), `biome.json`, `package.json` scripts, released CHANGELOG sections, any logic.

### Data model, API

None. No schema, protocol or API change.

### Tests

No new tests: this card is formatting and changelog editing only, and the existing unit suites are the regression check (standing order "no or weak tests": the existing tests cover AC3). The changed file is itself a web unit test (`apps/web`, vitest); it must still pass after the wrap. The CHANGELOG-reading tests (`packages/shared/test/release-changelog*.test.ts`, `apps/server/test/release-changelog-parity.test.ts`, `release-docs-prep-changelog*.test.ts`, `releases.test.ts`) run as part of `pnpm test`. Integration and e2e suites are left to the testers.

### Risks

- **Lint warnings mistaken for format issues.** `pnpm lint` prints thousands of warnings; only errors fail it. Judge by the exit code and the linter-off run, and do not start "fixing" warnings.
- **`--unsafe` fixes** would remove unused imports or variables (a code change). Forbidden.
- **Biome version drift.** The lockfile pins 2.5.15. Use `pnpm exec biome` / `pnpm format`, never a global biome.
- **Untracked `.mcp.json`** in the checkout gives a permission error in the sandbox. Not a repository file; ignore it, do not change the biome config for it.

## Acceptance criteria mapping

| AC | How it is met |
|---|---|
| AC1 The card records whether formatting issues and duplicate headings existed on the release working branch | Recorded here and on the card: at `d0314804` neither existed; at `02d3b1c6` formatting had one finding (from GWP-160) and the CHANGELOG had no repeat. The builder confirms in the handoff |
| AC2 `pnpm format` then `biome check` reports no formatting or import-order issues, including the three named files | Step 2: `pnpm format` wraps the one line; `pnpm lint` exits 0 and the linter-off run reports 0 findings; the three named files are already clean |
| AC3 Diff is formatting only; typecheck and test unchanged | Steps 1, 2 and 4: baseline vs after, diff review, safe fixes only |
| AC4 Unreleased has no repeated `### ` heading; entries kept; released sections byte-for-byte unchanged | Step 3: holds today with no edit; merge only if a repeat appears by build time, with hunks inside Unreleased only |

## Assumptions about GWP-165 (reviewed after it landed)

1. GWP-165 touches `ship.ts`, `desk.ts`, `release-ship.ts`, `runner.ts`, `handlers.ts` and `protocol/runner.ts`. **Holds** (it also added `ship-stuck.ts` and touched `phases.ts`; biome covers the whole tree anyway).
2. The tree passes `pnpm lint` after GWP-165 lands; at most a missed format run. **Revised**: GWP-165's own files are clean, but the working branch no longer passes `pnpm lint` because GWP-160 (merged just before) left one over-width line. Step 2 now runs `pnpm format` for real and the build has a one-file formatting diff.
3. GWP-165 adds at most one or two Unreleased CHANGELOG entries and does not touch released sections. **Holds**: one bullet under the existing `### Fixed`, no new heading, no released section touched.
4. GWP-165 does not change `biome.json` or the biome version (2.5.15). **Holds**.
