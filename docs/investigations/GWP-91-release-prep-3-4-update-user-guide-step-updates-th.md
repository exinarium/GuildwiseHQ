# GWP-91 Release prep (3/4): the 'Update user guide' step

Design report. First written on GuildwiseHQ `release/1.5.0` (tip 3bc3b30b) before GWP-89 landed. **Revised on
2026-11-04 against the landed GWP-89 frame** (merge 5c6c19fe): `packages/shared/src/release/docs-prep.ts`,
`docs-prep-dto.ts`, `apps/server/src/release/docs-prep.ts`, `apps/runner/src/git/release-docs-prep.ts`,
`release-docs-prep-steps.ts`, migration `2830_release_docs_prep.sql`, `apps/web/src/components/delivery/ReleaseDocsPrepTab.tsx`.
Section 0 says what changed. Sections 4.1, 4.7, 4.8, 4.10, 4.11, 5, 6 and 10 are rewritten to the landed names; the
guide helpers (4.2 to 4.6) and the prompt (4.9) stand as designed.

## 0. Assumption review (GWP-89 landed)

| # | Assumption | Holds? | What the landed code does | Design change |
|---|---|---|---|---|
| 1 | Step registry (key, order, defaultOn, requires, runner capability); disabled steps not sent | **Partly** | `ReleaseDocsPrepStepDef { id, label, description, order, defaultOn, producesFiles, last? }` in `STEPS`. No `requires`, no per-step capability: one workstation capability `release-docs-prep:1`; a runner without a handler answers "this runner has no handler for the step 'guide': update the runner". Disabled steps are not in `run.steps` (frozen at `ReleaseDocsPrepStarted`) and are never dispatched. | Register `GUIDE_STEP` (id `guide`, order 30) in `STEPS`. Add an optional `requires?: string[]` to the def and refuse the start when a ticked step needs an unticked one (4.10). No new capability, no `RUNNER_VERSION` bump. |
| 2 | Analysis gives per-repo change items with stable ids, titles and files/areas | **Partly** | `ReleaseDocsPrepSummary`: `commits[] {sha, subject, author, date}`, `merges[] {sha, subject, cardKeys, prNumber}`, `cards[] {key, title: null}`, `areas[] {area, counts, paths}` for the whole repo. Ids (SHAs, card keys) are stable; there are no per-item files and no card titles. | The runner derives change items itself in the handler (4.7a): one item per first-parent merge (files from `git diff --name-only <m>^1 <m>`), plus direct commits when there are no merges. Source ids `card:<KEY>`, else `merge:<sha>` / `commit:<sha>`. |
| 3 | Steps run in registry order in one per-repo prep worktree, with a read-only model runner and an exec with time limits | **No** | Each content step runs in its **own** throwaway integration worktree cut from the kept work ref `refs/guildwise/docs-prep/<run>/work` (so earlier steps' changes are there as commits; the worktree starts clean), under the repo lock. The handler gets only `{ worktree, payload, summary }` and returns `{ ok, files }`. There is no model runner and no exec in the context; the payload carries no agent. | Extend `DocsPrepStepContext` with `runModel` and `exec` (4.7b), built in `runner.ts`. The server adds a `writer` agent spec to the payload of model-backed steps (4.10). The snapshot of 4.7 step 2 is dropped (the worktree is clean); the runner's own "unexpected changes" check enforces the path limit, and the handler keeps its clearer check. |
| 4 | Commit results commits each step's reported files (PDF included), only when all enabled steps passed in every repo, to the branch ship uses | **Yes** | `contentStep` runs `git add -- <files>` of the handler's list, refuses unlisted changes, commits on the work ref; `commit/prepare` squashes `tree(work)` onto the release branch, `commit/push` pushes, and only after every repo passed every step (`nextReleaseDocsPrepAction`). Binary files go in with the tree. | None. The handler returns the guide, `guide.html` and the PDF in `files`. |
| 5 | Step results stored per run, step and repo as JSON, sent live; earlier runs readable for coveredSources | **No** | `release_docs_prep_steps` stores `state, files, error` only. The result's `notices` are dropped, and there is no step output field. Earlier runs are readable (`release_docs_prep_runs` / `_repos` / `_steps`). | Add an additive `output` (step JSON, capped 64 KB) to the handler return, `ReleaseDocsPrepResultSchema`, the `ReleaseDocsPrepStepFinished` event, a new `output jsonb` column (migration) and the run DTO (4.10). `coveredSources` are read from `output` of earlier passed runs (4.8). This carries AC1's "names the sections changed". |
| 6 | Prep runs on the workstation with network and the shared pnpm store and Playwright cache | **Yes** | `release.docs_prep` is a runner command executed by the runner process (`runner.ts:2147`), not a shift sandbox. | None. Note the repo lock is held for the whole handler (risk in section 8). |
| 7 | GWP-89 documents prep in USER-GUIDE 4.28 | **Yes** | `docs/USER-GUIDE.md` 4.28 Releases, the "Release prep (docs and videos)" paragraphs (lines 1403 to 1405). | Add one sentence there about **Update user guide**. |

Shared with GWP-90 (built first in the group by the same builder): the `requires` field, the `output` column, the
`runModel` / `exec` context and the `writer` payload field are generic. Whichever card is built first adds them; the
other reuses them unchanged. If GWP-90 lands a different shape for them, follow GWP-90's shape.

## 1. Question

How does a release prep step update each attached repository's user guide for the features changed in the release, so
that:

- only the sections the release touches change, and there is no wholesale rewrite,
- existing headings, numbers, anchors and cross-references keep working, and a new feature gets a section numbered like
  its neighbours,
- the illustrated PDF guide is rebuilt the way it is built today and goes into the same commit,
- a repo without a guide is skipped without failing the step, a second run changes nothing, and a disabled step changes
  nothing?

Planner's open points, answered here:
(a) numbering of a new section: section 4.3 (letter suffix after the related section, or the next number at the end of
the chapter, never a renumber);
(b) the in-app Help articles: not edited by this step. The card limits run-time edits to `docs/USER-GUIDE.md` and
`docs/guide/`. The guide's `/help/...` references are checked, and a follow-up goes on the backlog (section 9);
(c) the 'Analyse changes' contract: now landed; see section 0 row 2 and 4.7a.

## 2. Findings

### 2.1 The guide's structure (GuildwiseHQ `docs/USER-GUIDE.md`, 2015 lines after GWP-89)

- `# Guildwise HQ: User Guide`, then an intro, then a generated contents block between `<!-- toc -->` and
  `<!-- /toc -->`, then the chapters.
- Chapters are `## N. Title` (1 to 11), plus **unnumbered** `##` chapters (`## Discovery: from an idea to a PRD`,
  `## Boardroom: a debate with a Chair`) and `## Appendix A.` / `## Appendix B.`.
- Sections are `### N.M Title`. Insertions use a **letter suffix** and existing numbers are never shifted: `3.4a`,
  `4.3a`, `4.3b`, `4.24a`, `4.24b`. A few `###` sections have no number (`### Reopening a finished card` in chapter 8,
  `### Playbooks and the / menu` under Boardroom, `### The section map`).
- `####` sub-headings occur inside sections. They are not in the contents.
- **Cross-references are written as section numbers in the text**, not as links: "(4.27)", "(4.5)", "4.10",
  "chapter 2". The only `](#anchor)` links are the generated contents. So "existing anchors and cross-links keep
  working" means: no existing heading line changes, no existing number changes, and new text only refers to numbers
  that exist.
- Each section ends with callouts in a fixed style: `> **Good to know:** ...`, `> **In the app:** Help, "<Article>"
  (`/help/<slug>#<id>`)`, `> **In the app:** watch the video "<Name>" ...`. Labels allowed by the PDF build: Tip,
  Good to know, Watch out, In the app, Before you start.
- Figures are `![Caption](guide/assets/<name>.jpg)` on their own line. `assemble-guide.mjs` exits 1 when a referenced
  figure does not exist. This step takes no screenshots, so it must not add figure lines for files that do not exist.
- **Appendix A, "The section map"** maps every sidebar entry to its guide sections (for example "Releases ... 4.28").
  It is the best map from a feature (page, route, sidebar label) to its section, and it must gain the number of a new
  section.

### 2.2 The PDF build (`docs/guide/README.md`)

- `node docs/guide/assemble-guide.mjs` turns `USER-GUIDE.md` into `guide.html` **and rewrites the contents block inside
  `USER-GUIDE.md`**. Its slug is `lower`, strip `` ` `` and `*`, drop `[^a-z0-9 _-]`, trim, spaces to `-`.
- `node docs/guide/build-guide.mjs` renders `Guildwise-HQ-User-Guide.pdf` with Playwright Chromium. It loads
  `@playwright/test` and `pdf-parse` from the `e2e` package, so it needs `pnpm install` and `playwright install chromium`.
- `guide.html` and the PDF are tracked in git.
- **Idempotency defect in `assemble-guide.mjs` (still there, line 214)**: the replacement writes `<!-- /toc -->\n` in
  front of the text that already follows the block (which starts with `\n`), so every run adds one blank line after the
  contents (commit 4e2a6c0e). This must be fixed (4.6).
- The PDF bytes are not reproducible (Chromium writes creation dates), so the PDF is rebuilt **only when the guide text
  changed in this run**.
- The footer date in `build-guide.mjs` and the cover date in `parts/cover.html` are hard-coded; left alone (section 9).

### 2.3 In-app Help

`apps/web/src/help/articles/*.md` are written by hand, not generated from the guide. Their anchors come from `{#id}` on
the headings. The step checks `/help/<slug>#<id>` references written by this run when the repo has that folder.

### 2.4 guildwise-cloud

It has no `docs/USER-GUIDE.md`, so it is reported as `skipped: no user guide`.

## 3. Options compared

| | A: model edits USER-GUIDE.md in place, code checks after | **B: model proposes section edits as JSON, code applies them (chosen)** | C: template text from change titles, no model |
|---|---|---|---|
| Only touched sections change | checked after, hard to repair | guaranteed by construction + self-check | guaranteed |
| Headings, numbers, anchors kept | model may renumber or retitle | heading lines are read-only, numbers come from code | guaranteed |
| Style and quality | good | good (the model writes the prose) | poor, fails req. 1 ("corrects text") |
| Idempotent | weak | source ids + duplicate checks + "unchanged -> no write" | strong |
| Diff for review | can be noisy | minimal | minimal |

The model only **proposes**; handler code edits the file. That makes AC3, AC6 and the "no wholesale rewrite" constraint
testable without a model.

## 4. Design

### 4.1 Flow (landed frame)

```
server advance()                                runner contentStep() -> handler 'guide'
'guide' ticked? -- no --> not in run.steps,     (own integration worktree from the kept work ref, repo lock held)
                          never dispatched (AC6)
        | yes
payload: summary + stepInput { guidePath,       1 guide file missing -> { ok, files: [], output: skipped 'no user guide' } (AC4)
  coveredSources, denyList } + writer           2 no summary (Analyse off) -> fail "turn on Analyse changes"
        -------------------------------------->  3 change items from summary + git (4.7a); uncovered = items - coveredSources
                                                   none -> pass, output nothing: 'no new changes'
                                                 4 parseGuide + checkGuideUpdate(null) -> structural error: fail
                                                 5 locateSections hints; runModel (read-only) writes edits JSON to outDir
                                                 6 validate; one repair round; still bad -> fail, nothing written
                                                 7 applyGuideEdits -> unchanged: pass, no write
                                                                   -> changed: checkGuideUpdate(before, after) -> write
                                                 8 PDF scripts present and the text changed -> exec assemble + build
                                                 9 changed paths inside the guide paths; return files + output
        <--------------------------------------  contentStep: git add files, refuse others, commit on work ref
ReleaseDocsPrepStepFinished { files, output }  -> stored in release_docs_prep_steps.output, shown on the Releases tab
'commit' squashes and pushes (unchanged GWP-89)
```

### 4.2 Shared helpers: `packages/shared/src/release/user-guide.ts` (new, pure, no fs)

```ts
export interface GuideHeading {
  line: number;            // 0-based line index
  level: 2 | 3 | 4;
  raw: string;             // the exact heading line, never rewritten
  number: string | null;   // '4', '4.28', '4.28a'; 'Appendix A' and unnumbered -> null
  title: string;           // text after the number
  slug: string;            // same algorithm as assemble-guide.mjs
}
export interface GuideSection {   // a ### section (or a ## chapter's intro)
  heading: GuideHeading;
  chapter: GuideHeading;          // its ## parent
  bodyStart: number; end: number; // [bodyStart, end) lines, end = next ## or ### heading
}
export interface GuideDoc { lines: string[]; eol: '\n' | '\r\n'; finalEol: boolean;
  toc: { start: number; end: number } | null; headings: GuideHeading[]; sections: GuideSection[] }

export const DEFAULT_GUIDE_PATH = 'docs/USER-GUIDE.md';
export function guideSlug(text: string): string;          // copy of assemble's slug (parity test)
export function parseGuide(md: string): GuideDoc;
export function guideOutline(doc: GuideDoc): string;      // "4.28 Releases (28 lines)" per line, for the prompt
export function renderGuideToc(doc: GuideDoc): string;    // byte-identical to what assemble-guide.mjs writes

/** Ranked sections that describe a feature (test-plan helper). */
export function locateSections(doc: GuideDoc, feature: {
  title: string; areas?: string[]; files?: string[]; routes?: string[] }): Array<{ section: string; score: number; why: string }>;

export type GuideEdit =
  | { op: 'replace_text'; section: string; find: string; replace: string; sources: string[] }
  | { op: 'append'; section: string; text: string; sources: string[] }
  | { op: 'add_section'; after: string; title: string; body: string; sources: string[] };

export type ApplyGuideOutcome =
  | { kind: 'changed'; md: string; changed: string[]; added: Array<{ section: string; after: string }>;
      duplicates: GuideEdit[] }
  | { kind: 'unchanged'; duplicates: GuideEdit[] }
  | { kind: 'error'; errors: string[] };

export function applyGuideEdits(md: string, edits: readonly GuideEdit[]): ApplyGuideOutcome;

/** Structure + link checks. before = null checks one file on its own. */
export function checkGuideUpdate(before: string | null, after: string, ctx: {
  assetExists: (relPath: string) => boolean;
  helpRef?: (slug: string, id: string | null) => boolean;  // only when the repo has the Help articles folder
  changedRanges?: Array<[number, number]>;                  // lines of after written by this run
}): { errors: string[]; warnings: string[] };
```

`parseGuide` rules: a heading is `^(#{2,4}) (.*)$` outside fenced code. Number pattern for `##`: `^(\d+)\.\s`
(chapter), for `###`: `^(\d+)\.(\d+)([a-z]?)\s`. `Appendix X.` and anything else is unnumbered.

`locateSections` scores each `###` section: words of the change title and areas that match the heading title (x3);
rows of the Appendix A section map whose sidebar label matches (x3, mapped to the numbers in that row); bold UI labels
and `/routes` in the section body that match the change's routes or words (x1); file paths mapped to words
(`apps/web/src/pages/Releases.tsx` -> "releases", `apps/server/src/release/` -> "release"). The top three per change go
to the prompt as hints. It is a hint, not a gate.

### 4.3 Numbering of a new section (planner question a)

`add_section.after` names an existing section (number, or exact heading title for an unnumbered one). The code picks
the number. The model never writes one, and an existing number is **never** changed:

1. `after` is the last numbered `###` of its chapter (for example 4.30) -> next integer: **4.31**, inserted right after
   it.
2. `after` is numbered and has a later sibling (4.28, followed by 4.29) -> base number plus the next free letter:
   **4.28a** (4.28b if 4.28a exists), inserted after the last lettered sibling of that base. `after` = 4.24a gives 4.24b.
3. `after` is unnumbered -> the new section is unnumbered too, inserted right after it.
4. Two new sections after the same base get consecutive letters, in edit order.
5. Letters stop at `z`; beyond that it is an error.

The heading line is `### <number> <title>` (or `### <title>`). Its slug must not equal an existing slug.

### 4.4 Applying edits (`applyGuideEdits`)

- `section` / `after` resolve to exactly one section (by number, else by exact title, case-insensitive). Unknown or
  ambiguous -> error naming it.
- `replace_text`: `find` must occur **exactly once** in that section's body (never in its heading line), must not span
  into another section, and `replace` must differ.
- `append`: inserted at the end of the section body, **before** its trailing run of `> **In the app:**` callouts, with
  one blank line on each side.
- `add_section`: `### <n> <title>`, a blank line, the body, a blank line.
- Body and text rules: no `#`, `##` or `###` lines (`####` allowed in `add_section` bodies), no `<!--`, no fenced HTML,
  callout labels only from the five known ones, a figure line only for an asset that exists.
- Duplicates (idempotency layer 3): `append` whose normalised text is already in the section, `replace_text` whose
  `replace` is present and `find` is not, `add_section` whose normalised title equals an existing heading title. Dropped
  and returned in `duplicates`.
- The contents block (if any) is re-rendered with `renderGuideToc`.
- No line changed -> `unchanged` (the caller does not write).
- **Self-check**: every line outside the edited section bodies, the inserted sections and the contents block is
  byte-identical to the input, in order; every input heading line is present unchanged and in order; EOL style and the
  final newline kept. Otherwise -> error "internal: edit would change text outside the named sections".

### 4.5 Checks (`checkGuideUpdate`), AC3

Errors (the repo fails, nothing is written):
1. The heading lines of `before` are all present in `after`, in order, unchanged, and their numbers are unique.
2. Numbered `###` sections ascend inside each chapter in (number, letter) order, with no gaps in the letters of a base.
3. Every `](#x)` link resolves to a heading slug of `after`, and no two headings share a slug.
4. The contents block equals `renderGuideToc(after)`.
5. In the lines this run wrote: every section number reference (`(?<![\w.])\d{1,2}\.\d{1,2}[a-z]?(?![\w.]\d)`) and
   every "chapter N" names an existing section or chapter.
6. Every figure line points to an asset that exists.
7. In the lines this run wrote: `/help/<slug>#<id>` resolves when `helpRef` is given (the handler gives it when
   `apps/web/src/help/articles/` exists). Without that folder it is a warning.
8. Size guard: lines changed or added by this run are at most 25% of the guide, and at most 6 edited plus 4 new sections
   per run. Over that -> error "the update would rewrite too much of the guide (N lines)".
9. Text scrub on written lines: ticket keys, SHAs, secrets and deny-list terms. If GWP-90 lands a shared scrub
   (`scrubChangelogEntry` or similar), reuse it; otherwise add the patterns to `user-guide.ts` and let GWP-90 reuse
   them. URLs, paths and commands are allowed.

Warnings (shown, do not fail): a structural oddity that existed before, and a new section whose sidebar page has an
Appendix A row that does not list it yet.

### 4.6 Build changes to the PDF scripts (one-time, in this card)

- `docs/guide/assemble-guide.mjs` line 214: make the contents rewrite idempotent. Replace the block **and the blank
  lines after it** with `<!-- toc -->\n**Contents**\n\n${tocMd}\n\n<!-- /toc -->\n\n`, for example
  `md.replace(/<!-- toc -->[\s\S]*?(?:<!-- \/toc -->\n*|(?=\n## ))/, ...)`, keeping the fallback when the closing marker
  is missing. Run it once and commit the normalised `USER-GUIDE.md` (the run of blank lines becomes one) and
  `guide.html`. Test: running it twice gives identical bytes.
- No other change to the scripts.

### 4.7 Runner side: `apps/runner/src/git/release-docs-prep-guide.ts` (new), registered in `release-docs-prep-steps.ts`

`DOCS_PREP_STEP_HANDLERS.guide = runGuideStep`. The handler runs inside GWP-89's `contentStep`: its own clean
integration worktree cut from the kept work ref (so the changelog commit of GWP-90 is already in it), under the repo
lock. `contentStep` stages the returned `files`, refuses any other change ("unexpected changes in the worktree"), and
commits on the work ref. The handler never runs git add, commit or push (requirement 5).

#### 4.7a Change items (replaces assumption A2)

`ReleaseDocsPrepSummary` has repo-level areas only. The handler builds items itself, in the worktree, read-only:

- One item per entry of `summary.merges`: `title` = merge subject, `sources` = `card:<KEY>` for each `cardKeys` entry,
  else `merge:<sha>`; `files` = `git diff --name-only <sha>^1 <sha>` (cap 200), `subjects` = `git log --format=%s
  <sha>^1..<sha>^2` (cap 20).
- When `summary.merges` is empty (direct commits), one item per `summary.commits` entry: `commit:<sha>`, files from
  `git show --name-only --format= <sha>`.
- `areas` per item = `areaOf(path, payload.components)` (exported from `release-docs-prep.ts`) of its files.
- `routes` per item: `/path` strings found in the subjects (cheap; optional).

Source ids are stable because the release branch is never rewritten.

#### 4.7b Context extension (replaces assumption A3; generic, shared with GWP-90/92)

```ts
// release-docs-prep-steps.ts
export interface DocsPrepStepContext {
  worktree: string;
  payload: ReleaseDocsPrepPayload;
  summary: ReleaseDocsPrepSummary | undefined;
  /** A scratch folder for this step (removed afterwards); the model writes only here. */
  outDir: string;
  /** One unattended model call as payload.writer: reads `readDirs`, writes only `writeDir`, no shell. */
  runModel: (req: { instructions: string; prompt: string; readDirs: string[]; writeDir: string; timeoutMs: number })
    => Promise<{ ok: true } | { ok: false; error: string }>;
  /** A process with a time limit and the runner's toolchain PATH; output redacted. */
  exec: (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) =>
    Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
}
export type DocsPrepStepHandler = (ctx: DocsPrepStepContext) => Promise<
  { ok: true; files: string[]; output?: unknown } | { ok: false; error: string; output?: unknown }>;
```

`runner.ts` builds them when it handles `release.docs_prep`: `runModel` uses the adapter of `payload.writer.runtime`
with `ensureSandbox(paths, writer.agentId, ...)` and the same read-only, headless profile as a discovery/boardroom
session turn in `chat/chat.ts` (`runSessionTurn`), but with no `aom` command allowed: read access to the worktree,
write access to `writeDir` only. No writer in the payload, or the runtime is not available -> the step fails with "no
agent on this workstation can write the release documentation". `exec` wraps `realExecutor` (`toolchain/exec.ts`)
with the toolchain PATH and the redactor the deploy exec uses (`delivery/exec.ts`). Tests inject fakes for both.

#### 4.7c Steps of `runGuideStep`

1. `guidePath = payload.stepInput?.guidePath ?? DEFAULT_GUIDE_PATH` (normalised, must stay inside the worktree).
   Missing or not a regular file -> `{ ok: true, files: [], output: { status: 'passed', skipped: 'no user guide' } }`
   and nothing else runs (AC4).
2. No `summary` -> fail "Update user guide needs Analyse changes: tick it in the release prep settings" (the start
   check of 4.10 normally prevents this).
3. Items (4.7a); `uncovered` = items with a source not in `stepInput.coveredSources`. None -> pass, no model, no write,
   no PDF, `output.nothing = 'no new changes'`.
4. `checkGuideUpdate(null, md, ...)` errors -> fail before any model run.
5. `runModel` with the step prompt (4.9), the outline, the uncovered items with their `locateSections` hints and the
   current text of the hinted sections. It writes `<outDir>/guide.json`, checked with zod (`GuideProposalSchema`):
   `{ edits: GuideEdit[], covered: [{source, section}], skipped: [{source, reason}], notes: string[] }`. Afterwards
   `git status --porcelain` of the worktree must be empty, else fail ("the writer changed files in the repository").
6. `applyGuideEdits`, then `checkGuideUpdate(before, after, ...)`. On errors, **one** repair round (the errors plus the
   current text of the sections it named; the model returns the whole JSON again). Still errors -> fail, nothing
   written.
7. `unchanged` -> pass, no write, no PDF. `changed` -> write the guide (utf8, EOL kept).
8. PDF, only when the guide bytes changed in step 7 and `<dirname(guidePath)>/guide/assemble-guide.mjs` exists (AC5):
   - `exec('corepack', ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'])` (10 min), then
     `corepack pnpm --filter @aom/e2e exec playwright install chromium` (5 min; a no-op when cached),
   - `node docs/guide/assemble-guide.mjs` (2 min), then `node docs/guide/build-guide.mjs` if it exists (10 min),
   - after assemble, read the guide again and run `checkGuideUpdate` on it (the parity test makes this a no-op),
   - non-zero exit or time-out -> fail with the last 20 lines of output: "the PDF guide could not be built: ...".
     Nothing is committed for any repo, because a failed step stops the run before Commit results.
9. `git status --porcelain -uall` (ignored paths such as `node_modules` do not show): every changed path must be the
   guide or under `<dirname(guidePath)>/guide/`, else fail "the guide build changed <path>". `files` = exactly those
   paths. This also enforces "must not touch CHANGELOG.md or videos"; `contentStep` repeats the check generically.
10. `output` (stored per run, step and repo; at most 64 KB, lists capped at 50):
    ```ts
    { status: 'passed' | 'failed', skipped?: 'no user guide', nothing?: 'no new changes',
      changed: Array<{ section: string; sources: string[] }>,   // '4.28 Releases'
      added: Array<{ section: string; after: string; sources: string[] }>,  // '4.28a Release prep'
      covered: Array<{ source: string; section: string }>,
      skippedChanges: Array<{ source: string; reason: string }>,
      duplicates: number, pdf: 'rebuilt' | 'no change' | 'no PDF build',
      warnings: string[], notes: string[] }
    ```
    Failures also return `output` (with the check errors) so the Releases tab can show them; the short message goes in
    `error` as today.

### 4.8 Idempotency (three layers)

1. **Sources** (replaces assumption A5): the server passes `stepInput.coveredSources` = the union of `changed[].sources`,
   `added[].sources`, `covered[].source` and `skippedChanges[].source` from `release_docs_prep_steps.output` of step
   `guide`, `state = 'passed'`, for the same project, release branch and repo, in runs with `status = 'passed'` that
   started after the last published ship (the `latestRun` freshness rule). Cap 2000 ids. A second run has nothing
   uncovered, so it does not run the model or the PDF build, and returns no files (GWP-89's "byte-identical when the
   content is already on the branch" contract).
2. **Model**: the prompt includes the current text of the hinted sections; a change the guide already describes goes
   to `covered`.
3. **Code**: the duplicate rules in 4.4, "unchanged -> no write", the PDF only when the text changed, and the fixed
   `assemble-guide.mjs`.

A failed run is not counted in layer 1 (its work ref is discarded), so a retry redoes the work.

### 4.9 The prompt: new playbook `packages/capabilities/playbooks/user-guide/`

`workflow.md` (an interactive "update the user guide for these changes" playbook, which also works from the `/` menu)
plus `steps/step-unattended.md` for prep. Then run `node packages/capabilities/generate.mjs` (regenerates
`packages/shared/src/capabilities/builtin-data.ts`; its check mode fails CI otherwise). The handler reads the
unattended step text from the generated built-in data, so the prompt has one source. Outline:

- Role: keep the user guide true for the changes given. No questions. Write for the guide's reader (non-programmers),
  in the guide's voice: short plain sentences, UI labels in **bold** exactly as in the app, routes and commands in
  backticks.
- For each user-visible change: correct sentences that no longer match (`replace_text`), add a paragraph to the section
  that covers the feature (`append`, a `**Bold lead.**` paragraph like the existing ones), or a new section when the
  feature has no home (`add_section` after the most related section; never write a number). Update the Appendix A row
  with the new section. Refer to other sections by number only if it exists in the outline.
- Never change a heading, never renumber, never delete a section, never add a figure, no ticket keys, commit ids,
  people or agent names. A heading that no longer fits goes to `notes`.
- Not user-visible (tests, refactors, build, internal tools) -> `skipped` with a reason.
- Output: only the JSON file at the given path. Do not edit files in the repository.

### 4.10 Server and shared (landed names)

- **Registry** (`packages/shared/src/release/docs-prep.ts`): `GUIDE_STEP = { id: 'guide', label: 'Update user guide',
  description: 'Updates the user guide sections for the changed features and rebuilds the PDF guide when the text
  changed. Needs Analyse changes.', order: 30, defaultOn: true, producesFiles: true, requires: ['analyse'] }`, appended
  to `STEPS` (order: analyse 10, changelog 20, guide 30, videos 40, commit 1000).
- **`requires`** (generic): add `requires?: string[]` to `ReleaseDocsPrepStepDef` and a pure
  `missingReleaseDocsPrepRequirements(steps)`; `startReleaseDocsPrep` throws `conflict('step_requires', 'Update user
  guide needs Analyse changes: tick it in the release prep settings.')`. The settings panel shows the description; no
  automatic ticking.
- **Payload** (`docs-prep-dto.ts`, additive, optional): `stepInput: z.record(z.string(), z.unknown()).optional()` and
  `writer: AgentRuntimeSpecSchema.optional()`. `advance()` fills them from a per-step hook map
  `DOCS_PREP_STEP_INPUTS: Record<stepId, (tx, run, repo) => Promise<{ stepInput?, needsWriter? }>>` in a new
  `apps/server/src/release/docs-prep-steps.ts` (the server twin of the runner's handler map). The `guide` entry returns
  `{ guidePath: DEFAULT_GUIDE_PATH, coveredSources, denyList }` and `needsWriter: true`. The runner validates
  `stepInput` with `ReleaseDocsPrepGuideInputSchema` (in `packages/shared/src/release/user-guide.ts`).
- **Writer** (generic): `docsPrepWriter(tx, run, repo)` picks an active agent hosted on the repo's recorded workstation
  (`repo.workstation_id`), in the project's organization, preferring role `architect`, then `ba`, then `builder`
  (stable order by name), and builds the spec with `agentSpecFor`. None -> the step is not dispatched; it fails with
  "no agent on the workstation that has <repo> can write the release documentation". If GWP-90 already landed a writer
  rule, use it.
- **Output** (generic, replaces A5): `ReleaseDocsPrepResultSchema.output: z.unknown().optional()` (the server drops it
  when its JSON is over 64 KB and adds a warning); `ReleaseDocsPrepStepFinished.payload.output` (optional);
  migration `28xx_release_docs_prep_step_output.sql`: `ALTER TABLE release_docs_prep_steps ADD COLUMN IF NOT EXISTS
  output jsonb`; the projector writes it; `ReleaseDocsPrepRunDtoSchema.repos[].steps[].output: z.unknown().nullable()`.
  The web parses it per step with the step's own schema (`ReleaseDocsPrepGuideOutputSchema`), so bad data shows the
  plain step row as today.
- **Disabled step** (AC6): nothing to add. A step that is not ticked is not in `run.steps` and is never dispatched;
  tests assert it.

### 4.11 Web: Releases page step output

In `apps/web/src/components/delivery/ReleaseDocsPrepTab.tsx`, the step row (`repo.steps.map`, line 168) gets an
optional renderer per step id; `guide` renders `GuideStepOutput` (new component in the same folder):

- One line per repo: "2 sections changed, 1 added (4.28a Release prep); PDF rebuilt", "skipped: no user guide", "No new
  changes", or the error (failed style, as today).
- Expanded: "Changed" and "Added" section lists (numbers and titles), "Not in the guide" (skipped changes with reason),
  notes and warnings. Plain React text nodes.
- All devices: the expander is a real `<button>` with `aria-expanded` and a 44 px target; nothing hover-only; long
  titles wrap at 360 px. Read-only, so the soft keyboard is not involved.

## 5. Files to change

| # | File | Change |
|---|---|---|
| 1 | `packages/shared/src/release/user-guide.ts` (new) + `index.ts` | 4.2 to 4.5 helpers, `DEFAULT_GUIDE_PATH`, `GuideProposalSchema`, `ReleaseDocsPrepGuideInputSchema`, `ReleaseDocsPrepGuideOutputSchema` |
| 2 | `packages/shared/src/release/docs-prep.ts` | `GUIDE_STEP`, `requires`, `missingReleaseDocsPrepRequirements` |
| 3 | `packages/shared/src/release/docs-prep-dto.ts`, `packages/shared/src/events/release-docs-prep.ts` | `stepInput`, `writer`, `output` (result, event, run DTO) |
| 4 | `apps/server/migrations/28xx_release_docs_prep_step_output.sql` (new), `apps/server/src/projections/release-docs-prep.ts` | `output jsonb` column and projector |
| 5 | `apps/server/src/release/docs-prep.ts`, `apps/server/src/release/docs-prep-steps.ts` (new) | requires check at start, step input hooks, writer pick, `output` in `applyReleaseDocsPrepResult` and `runDto` |
| 6 | `apps/runner/src/git/release-docs-prep-steps.ts`, `release-docs-prep.ts`, `runner.ts` | context `outDir`, `runModel`, `exec`; handler `output` passed through `contentStep` |
| 7 | `apps/runner/src/git/release-docs-prep-guide.ts` (new) | `runGuideStep` (4.7) |
| 8 | `packages/capabilities/playbooks/user-guide/{workflow.md,steps/step-unattended.md}` (new) + regenerated `builtin-data.ts` | 4.9 |
| 9 | `docs/guide/assemble-guide.mjs` | idempotent contents rewrite (4.6); `USER-GUIDE.md` and `guide.html` normalised once |
| 10 | `apps/web/src/components/delivery/ReleaseDocsPrepTab.tsx`, `GuideStepOutput.tsx` (new) | 4.11 |
| 11 | Docs | `USER-GUIDE.md` 4.28 (one sentence on **Update user guide** in the release prep paragraph), `docs/guide/README.md` ("Release prep rebuilds the PDF when the guide text changes"), `CHANGELOG.md` Unreleased entry |

Rows 2 (`requires`), 3, 4, 5 (writer, hooks, output) and 6 are generic. If GWP-90 already added them, reuse them.

## 6. Acceptance criteria -> design -> tests

| AC | Design | Test (unit, builder) |
|---|---|---|
| Changed feature -> matching section updated, output names it | 4.2 `locateSections`, 4.4, 4.7a items, 4.7c `output.changed`, 4.10 `output` column | shared: `locateSections` on a sample guide (Releases change -> 4.28 first; Appendix A row used); `applyGuideEdits` edits only 4.28. Runner: temp repo with a merge commit touching `apps/web/src/pages/Releases.tsx`, fake `runModel` writing JSON: diff touches only 4.28, `output.changed = ['4.28 Releases']`. Server: `output` stored and returned in the run DTO |
| New feature -> new section numbered like its neighbours | 4.3 | shared: after 4.28 -> 4.28a; again -> 4.28b; after the last of a chapter -> next integer; after 4.24a -> 4.24b; after unnumbered -> unnumbered; slug clash -> error |
| Headings, numbers, links still resolve | 4.4 self-check, 4.5 checks 1 to 7, 4.6 | shared: every check has a failing case. `renderGuideToc` on the real `docs/USER-GUIDE.md` equals its contents block. Script test: `assemble-guide.mjs` run twice on a temp copy gives identical bytes |
| Repo without guide -> 'skipped: no user guide', step passes | 4.7c step 1 | runner: temp repo without a guide -> `ok`, no files, `output.skipped`, no `runModel` call. Server: the step row is `passed` |
| PDF regenerated and committed with the text | 4.7c steps 8 and 9, `files` -> `contentStep` -> commit | runner with a fake `exec` writing `guide.html` and the PDF: run only when the text changed; `files` lists the three; exec failure -> fail. A real PDF build is for the testers |
| Step disabled -> no guide change | 4.10: not in `run.steps`, never dispatched | shared/server: a run without `guide` ticked never dispatches it; the work tree after the run has the guide bytes unchanged |
| Constraints: idempotent, no CHANGELOG/videos, no commit | 4.8, 4.7c steps 5 and 9 | runner: second run with `coveredSources` -> no `runModel`, no write, no exec, no files. Fake build touching `CHANGELOG.md` -> fail. Model writing in the worktree -> fail. Handler leaves `git log` unchanged. Server: `coveredSources` built from passed runs only |
| Requires Analyse | 4.10 `requires` | shared: `missingReleaseDocsPrepRequirements`; server: start with guide on and analyse off -> 409 `step_requires` |

Web: a renderer test (changed, added, skipped repo, failed, malformed output falls back). E2E (`e2e/**`, testers):
seeded project with Analyse, Guide and Commit on, the mock model, the diff of `docs/USER-GUIDE.md` touches only the
changed sections, a markdown link check passes, then ship succeeds.

## 7. Edge decisions

| Case | Behaviour |
|---|---|
| Guide exists but the release has no user-visible change | Model returns only `skipped` -> pass, "no guide change needed", no write |
| A change removes a feature | `replace_text` saying it is gone. No section deletion (anchors stay) |
| The guide has no contents block | Nothing to re-render; check 4 skipped |
| Guide at the path but no `docs/guide/` scripts | Text updated, `pdf: 'no PDF build'` |
| CRLF guide | Kept CRLF |
| pnpm or Chromium cannot install | Repo fails with the output tail. Ship stays blocked until Retry or Skip |
| Model output still invalid after one repair | Fail, errors listed in `output`, nothing written |
| Analyse off, guide on | Start refused (`step_requires`); an old run without summary fails the step with the same text |
| No agent on the repo's workstation | Step fails with the "no agent ... can write" message; Skip remains |

## 8. Risks

- **Repo lock held for minutes** (new, from the landed frame): `runReleaseDocsPrep` holds `withRepoLock` for the whole
  handler, so a model call plus a PDF build (up to about 25 minutes) blocks other git work on that clone of the
  workstation. Prep runs right before a ship, when little else happens on the release clone. The builder checks which
  runner operations take the same lock; if card shift starts wait on it, raise it in the handoff (a follow-up can run
  the model before taking the lock).
- **PDF build cost and environment**: `pnpm install` in a fresh integration worktree plus Chromium (minutes, network on
  the first run). It runs only when the text changed. Failures are clear and retryable.
- **Running repo scripts**: `assemble-guide.mjs` / `build-guide.mjs` come from the release branch of the owner's repo,
  the same trust as deploy recipe scripts. They run outside the model, with time limits and a check of the changed
  paths.
- **Writer pick**: the first agent rule (architect, ba, builder on the repo's workstation) is a sensible default. A
  project setting can come later.
- **Section-number regex** false positives (a time "10.30"): only lines written by this run are checked, and the error
  names the fragment.
- **One-time normalisation of `USER-GUIDE.md`** may conflict with GWP-90/92 docs edits. Trivial: keep one blank line.
- **Model quality**: wrong edits are blocked, not fixed silently. The owner can edit the guide by hand and use Retry or
  Skip.

## 9. Follow-ups (backlog suggestions, not this card)

- Release prep: also update the in-app Help articles (`apps/web/src/help/articles/`) for changed features.
- PDF guide: take the footer and cover date from the release instead of the hard-coded "7 October 2026".
- A per-repository "user guide path" setting (this card uses the fixed default `docs/USER-GUIDE.md`).
- A project setting for which agent writes the release documentation.

## 10. Assumptions after the review

Checked against the landed GWP-89 code (section 0). Held: A4 (commit of the step's files, binary included, only when
all passed), A6 (prep runs in the runner process on the workstation), A7 (prep documented in 4.28). Revised: A1
(registry shape; `requires` added; no per-step capability), A2 (change items derived in the handler), A3 (own worktree
per step; `runModel`/`exec` added to the context; writer in the payload), A5 (`output` column added; covered sources
read from it).
