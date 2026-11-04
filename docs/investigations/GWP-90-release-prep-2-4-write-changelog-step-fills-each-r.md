# GWP-90 Release prep (2/4): the 'Write changelog' step

Design report. Base read: `release/1.5.0` of GuildwiseHQ (tip 18aa061d) and `release/1.5.0` of guildwise-cloud (tip d358a6f).
**Revised 2026-11-04 after GWP-89 landed on `main` (merge 5c6c19fe).** Section 9 records the assumption review. Sections
4.1, 4.3, 4.6, 4.7, 5 and 6 changed. Assumptions 3, 4 and 7 did not hold:

- 3: the registry has no `requires`.
- 4: a runner step handler cannot run a model. The model part now runs as a BA background task (`ba_tasks`), the way
  `spec_card` and `mail_reply_draft` already work.
- 7: step rows store only `files` and `error`, so this card adds a generic `output` column.

The shared helpers (4.2), the entry format (3), duplicate handling (4.4) and the edge decisions (4.5) did not change.

## 1. Question

How does a release prep step write user-facing entries into the `## [Unreleased]` section of every attached repository's
`CHANGELOG.md` so that:

- the existing ship code (`commitRelease` -> `releaseChangelog` / `newChangelog`) and the public release notes
  (`parseChangelog` / `buildReleases` / `publicText`) keep working unchanged and pick the entries up,
- existing entries survive, nothing is duplicated and a second run adds nothing,
- a bad file fails that repository clearly, and a disabled step does not touch the file at all?

Planner's open points, answered here: the entry format (section 3), how the model's output is checked before writing
(section 4.3), what happens for a repo with no change summary (section 4.5), and whether "already covers" is matched by
text or by id (section 4.4: both, by source ids from earlier runs and by normalised text).

## 2. Findings

### 2.1 What the existing code reads

- `splitUnreleased` (shared, `changelog-rewrite.ts:30`) finds the first `## [unreleased]` line (case-insensitive). The
  block ends at the next `## [..]` heading or a link reference `[x]: ...`. Its intro is the non-blank lines before the
  first `###`, and its body runs from the first `###` to the end of the block.
- `releaseChangelog` (shared, `:89`) returns `already` when **any** `## [version]` heading for the target version
  exists. It does not check for a date. Otherwise it moves the Unreleased body under `## [version] - date` and leaves an
  empty `## [Unreleased]`. It returns `error` when there is no Unreleased section.
- `newChangelog` (`:114`) writes the header `# Changelog` / blank / `All notable changes to <project name> are documented
  in this file.` / blank / `## [Unreleased]` / blank, then the first release.
- `scanChangelog` / `parseUnreleased` / `parseChangelog` (server, `apps/server/src/blog/releases.ts`) only count bullets
  (`- ` or `* `) under a `### <Word>` heading. `SECTION_OF` maps `added`, `changed`, `removed`, `deprecated`, `fixed` and
  `security`. Any other heading (for example `### New`, `### Improved`, `### Highlights`) gives `section = null`, so
  its bullets **are dropped from the public page and from the proposal counts**. A continuation line must be indented.
  A blank line ends a bullet.
- `parseChangelog` skips undated version sections (`## [1.5.0]` with no `- YYYY-MM-DD`).
- `buildProposal` (server, `release/proposal.ts`) counts Unreleased `added` / breaking entries to recommend the version
  bump and previews the section with `composeReleaseSection`. Open proposals read the repo facts live (reconcile rule 4),
  so after the prep commit lands and the facts are refreshed, the ShipReleaseItem preview shows the new entries with no
  ship code change.
- `publicText` strips `/help/` links, `(#12)` and `#12` references and `@handles`, collapses double spaces, removes the
  space before punctuation and trims.
- The repo release facts (`RepoReleaseFacts.changelog`, read by `apps/runner/src/git/release-facts.ts:177`) carry the
  full `CHANGELOG.md` text (up to 1 MiB) at the release branch head. The server can therefore read the current
  Unreleased block without asking the runner.

### 2.2 The existing 'Release notes' playbook does not fit as is

`packages/capabilities/playbooks/release-notes` is an **interactive** facilitator playbook ("ask one question at a
time", "use only changes the owner confirms"), and its headings are **Highlights, New, Improved, Fixed, Behind the
scenes, Upgrade notes**. Apart from `Fixed`, none of these is in `SECTION_OF`, so entries written under them would never
reach the release page. The step must use the Keep a Changelog headings and run unattended. Decision: extend the
playbook with an unattended changelog step file that maps its groups onto those headings (section 5.6). The interactive
flow stays unchanged.

### 2.3 The two repositories today

- **GuildwiseHQ `release/1.5.0`**: `## [Unreleased]` holds one entry (Retire a workstation). It is followed by an
  **undated `## [1.5.0]` heading** with the forms, storage, journeys and move entries. Cards added it by hand
  (144ed5c5, 1b23b0b3, 6e436c18). With that heading present:
  - `shipLocked` sees `hasReleaseSection(.., '1.5.0')` and returns `alreadyDone`. Nothing is committed, the section is
    never dated, and the Unreleased entries (including anything this step writes) are **not** released.
  - `parseChangelog` drops the undated section, so 1.5.0 never appears on the public release page.

  This is a problem in the file today, prep or no prep. It breaks AC4 and AC5 for GuildwiseHQ unless it is fixed first.
  The step must detect it and fail with a clear message rather than write entries that ship will ignore (section 4.2).
  The owner has been asked (decision on the card). The step does not fold the heading into Unreleased automatically.
- **guildwise-cloud `release/1.5.0`**: a `newChangelog`-style file, `All notable changes to Guildwise HQ Platform ...`,
  an empty `## [Unreleased]`, then `## [0.1.0] - 2026-11-03` with commit subjects as entries (tight bullets, no blank
  line between them). Its version line (0.1.x) differs from GuildwiseHQ (1.x). So the step must not assume one version
  for all repos. Only GuildwiseHQ's `CHANGELOG.md` feeds the public release page (`locateReleaseSource`). The cloud's
  entries reach its own release commit and GitHub release (`notesSource: 'changelog'`).

### 2.4 Bullet styles

GuildwiseHQ separates bullets with a blank line ("loose"). guildwise-cloud does not ("tight"). Both parse the same. The
merge keeps the style it finds, so diffs stay clean.

### 2.5 What GWP-89 landed (read on `main`, merge 5c6c19fe)

- Shared `packages/shared/src/release/docs-prep.ts`: `ReleaseDocsPrepStepDef { id, label, description, order,
  defaultOn, producesFiles, last? }`, `STEPS = [ANALYSE_STEP (10), COMMIT_STEP (1000, last)]` ("sibling steps append one
  import and one entry here"), `enabledReleaseDocsPrepSteps`, and `nextReleaseDocsPrepAction`. Only `commit` has phases
  (`prepare`/`push`), and they are hard-coded.
- The run freezes `steps` at start, from the enabled steps only. A step that is off is never dispatched.
- Server `apps/server/src/release/docs-prep.ts`: `advance()` sends one `release.docs_prep` runner command per (step,
  repo). The payload carries the repo's `summary` once 'analyse' has run. `applyReleaseDocsPrepResult` appends
  `ReleaseDocsPrepStepFinished` with `files`, `error`, `summary`, `commit` and similar fields. When the run passes, it
  calls `requestReleaseFacts` for each repo that got a commit.
- Runner `apps/runner/src/git/release-docs-prep.ts`: a content step runs `DOCS_PREP_STEP_HANDLERS[step]({ worktree,
  payload, summary })` in a throwaway integration worktree. That worktree starts from the kept work ref, or from
  `summary.headSha` on the first step. The runner then runs `git add` on the handler's files and refuses any other
  change. It commits the files to `refs/guildwise/docs-prep/<run>/work`, and 'commit' squashes them onto the release
  branch. The handler contract says: "byte-identical files when its content is already on the branch". The handler gets
  **no model or agent**.
- Tables: `release_docs_prep_runs`, `release_docs_prep_repos` (`summary jsonb`, `base_tag`, `head_sha`, `commit_sha`,
  `pushed`), `release_docs_prep_steps` (`files text[]`, `error text`, **no output column**). `ReleaseDocsPrepResultSchema`
  has `notices`, but they are not stored. `ReleaseDocsPrepRunDto.repos[].steps[]` has no output.
- The runner capability is `release-docs-prep:1`. A runner without a step handler fails with "this runner has no handler
  for the step '<id>': update the runner".
- Web: `apps/web/src/components/delivery/ReleaseDocsPrepTab.tsx` shows the run per repo and step, and
  `ReleaseDocsPrepPanel.tsx` is the settings checklist.

### 2.6 How unattended model work already runs

Model work never runs inside a runner command. It runs in an agent shift on the user's workstation, with the agent's own
login. Background work without a card is a **BA task**: a `ba_tasks` row of a given `kind` (`spec_card`,
`mail_reply_draft`, `batch_intake` and others). It is queued with `BaTaskQueued` and picked up by
`dispatcher/ba-tasks.ts`. The brief comes from `runner-gateway/ba-task-brief.ts`. The agent reports an outcome with
structured `data` (`aom spec-card ...` -> `outcome('spec_card_done', ..., data())`). The server applies it in
`commands/ba-tasks.ts` (`applySpecCardReport`). If the server **rejects** a report (`{ accepted: false, error }`), the
agent sees the error and can fix and report again in the same shift. That gives the repair round for free. A timeout or
crash runs the kind's fallback (`runSpecCardFallback`).

## 3. The entry format (fixed here)

- Headings: only the Keep a Changelog ones the parser maps, in this order: `### Added`, `### Changed`,
  `### Deprecated`, `### Removed`, `### Fixed`, `### Security`. The writer normally uses Added / Changed / Fixed.
  Deprecated / Removed / Security are allowed when a change is exactly that.
- One entry = one bullet `- <text>` on **one line** (no continuation lines, no nested bullets), like every existing
  GuildwiseHQ entry.
- Text: starts with a short phrase naming the feature or fix, then one to four sentences on what the user can now do or
  what no longer goes wrong, and why it matters. Plain sentences. `**bold**` for a UI label and backticks for a
  setting, variable or endpoint a self-hoster needs are allowed (the existing entries do this). No links into `/help/`,
  no `#123`, no `@handle`, no ticket keys (`GWP-90`), no commit SHAs, no hostnames, URLs, emails or IPs, no agent,
  workstation or people names, no secrets, nothing about how the work was organised (reviews, rework, shifts).
- Breaking changes: the word `BREAKING` at the start of the text, under `### Changed` or `### Removed`. `parseUnreleased`
  counts it, so the version recommendation goes to major as today.
- Internal-only work (refactors, build, tests, "Behind the scenes") is **not** written.

Example (GuildwiseHQ style):

```markdown
## [Unreleased]

### Added

- Retire a workstation with agent handover. ...existing entry, untouched...

- Release prep on the Releases page. An Owner or Admin can turn on a prep run that writes the changelog before a release ships, and see each step's result per repository.

### Fixed

- The release page no longer misses entries written under an unknown heading.
```

## 4. Design

### 4.1 Overview

The step has a model part and a deterministic part. The model only **proposes** entries as JSON. Code checks them,
removes duplicates and merges them into the Unreleased block. The model never edits `CHANGELOG.md`. That is what makes
"only Unreleased is edited", the format, idempotency and "disabled means byte-identical" testable guarantees.

GWP-89's runner handlers cannot run a model (2.5), so the step has two parts, both inside GWP-89's single step row
`changelog` per repo:

1. **Propose** (server + BA task): when the run reaches `changelog`, the server queues one BA task per repo, kind
   `release_changelog`. The BA writes the proposal and reports it with `aom release-changelog --file <json>`. The server
   checks and scrubs it. If the check fails, the report is rejected with the findings and the BA fixes it in the same
   shift (the repair round). Once accepted, the server sends the runner command.
2. **Apply** (runner, GWP-89's content step): `DOCS_PREP_STEP_HANDLERS.changelog` reads the file in the prep worktree,
   runs `checkChangelog`, merges the accepted entries with `mergeUnreleased`, writes only if the file changed, and
   returns `files` plus an `output`. GWP-89 then commits it to the kept ref, and 'commit' squashes and pushes as today.

```
server advance(): step 'changelog' for repo R (only if the step is in run.steps, i.e. enabled)
  ├─ no summary (Analyse off)                  -> step failed: "Write changelog needs Analyse changes ..."
  ├─ workstation lacks release-docs-prep-changelog:1 -> step failed: "... needs a newer runner"
  ├─ facts.changelog present and checkChangelog errors -> step failed with the sentence (no tokens spent)
  ├─ uncovered = summary sources - coveredSources - earlier prep commits; empty -> runner command with entries=[]
  └─ otherwise: ReleaseDocsPrepStepStarted (row 'running', no command yet) + BaTaskQueued{kind:'release_changelog'}
                     │
BA shift (user's workstation) reads the brief: repo name, numbered uncovered changes, numbered existing Unreleased bullets
                     │  aom release-changelog --file proposal.json      (or aom release-changelog-fail --note)
server applyReleaseChangelogReport: zod + scrubChangelogEntry + deny list
  ├─ findings -> { accepted:false, error: "entry 2: contains a ticket key 'GWP-74'" }  (BA fixes, reports again)
  └─ ok -> task done; enqueue release.docs_prep {step:'changelog', changelog:{projectName, entries, proposal}}
                     │
runner handler (prep worktree from the kept work ref):
  read CHANGELOG.md -> checkChangelog -> mergeUnreleased(md ?? changelogSkeleton(name), entries)
  unchanged -> files [] ; merged -> write, files ['CHANGELOG.md'] ; error -> {ok:false}
  output {added, duplicates, created, warnings}
                     │
applyReleaseDocsPrepResult: store output (new column) merged with the proposal's covered/skipped; advance()
```

### 4.2 Shared helpers (packages/shared/src/release/changelog-rewrite.ts, plus a new changelog-entries.ts)

Add these and leave the existing functions as they are. `newChangelog`, `releaseChangelog`, `splitUnreleased`,
`releaseSectionOf` and `hasReleaseSection` keep their behaviour and signatures.

```ts
export type ChangelogHeading = 'Added' | 'Changed' | 'Deprecated' | 'Removed' | 'Fixed' | 'Security';
export const CHANGELOG_HEADINGS: readonly ChangelogHeading[] =
  ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

export interface ChangelogEntry { heading: ChangelogHeading; text: string }

/** Structural problems that make the file unsafe to edit or unusable by ship. Empty = fine. */
export function checkChangelog(md: string, opts?: { version?: string }): { errors: string[]; warnings: string[] };
// errors (each a full sentence naming the line number):
//  - no '## [Unreleased]' heading                        ("CHANGELOG.md has no ## [Unreleased] section")
//  - more than one '## [Unreleased]' heading
//  - '## [Unreleased]' below a version heading            (ship would move the wrong block)
//  - an undated version heading '## [x.y.z]' above the newest dated one, or opts.version already a heading:
//    "CHANGELOG.md already has a ## [1.5.0] section without a date (line 11). Ship would treat 1.5.0 as released and
//     ignore Unreleased. Move its entries under ## [Unreleased] and remove the heading, then retry prep."
//  - a bullet in the Unreleased block that is not under a '###' heading (the parser drops it)
//  - a NUL byte or invalid UTF-8 replacement chars (binary or corrupted file)
// warnings (do not fail, shown in the output): an Unreleased '###' heading not in SECTION_OF.

/** The header newChangelog writes, ending with an empty Unreleased block. */
export function changelogSkeleton(projectName: string): string;
// '# Changelog\n\nAll notable changes to <name> are documented in this file.\n\n## [Unreleased]\n'
// Test: equals the prefix of newChangelog(...).md up to and including '## [Unreleased]\n'.

/** The bullet texts under Unreleased (continuation lines joined), for the brief and the duplicate check. */
export function unreleasedBullets(md: string): { heading: string; text: string }[];

export type MergeUnreleasedOutcome =
  | { kind: 'merged'; md: string; added: ChangelogEntry[]; duplicates: ChangelogEntry[] }
  | { kind: 'unchanged'; duplicates: ChangelogEntry[] }
  | { kind: 'error'; message: string };

/** Adds the entries that are not already in the Unreleased block. Every byte outside the block is kept. */
export function mergeUnreleased(md: string, entries: readonly ChangelogEntry[]): MergeUnreleasedOutcome;

/** Normalised text used for duplicate checks. */
export function entryKey(text: string): string;
export function isDuplicateEntry(a: string, b: string): boolean;
```

`mergeUnreleased` algorithm:

1. If `checkChangelog(md).errors` is not empty, return `error` with the first one. Then `split = splitUnreleased(md)`.
2. Take the block lines `[start+1, end)` from `linesOf(md)` (export `linesOf`, or copy it). Keep the EOL style and the
   trailing-newline flag. Parse the block into the preamble (lines before the first `###`) and sections
   `{ headingLine, name, lines[] }`. Trailing blank lines are dropped and put back as exactly one blank line before the
   next heading, as `releaseChangelog` does. If there is no next heading, the file ends with one EOL.
3. Existing bullets = every `- ` / `* ` bullet text in the block (joined continuation lines included).
   For each new entry: drop it if `isDuplicateEntry` matches any existing bullet or a new entry already accepted.
   Duplicates are returned.
4. Nothing left -> `unchanged` (the caller does **not** write the file).
5. Style: "loose" when any section of the block, or else the first `###` section of the file with two or more
   bullets, has a blank line between bullets. Otherwise "tight". A file with no bullets at all is loose.
6. Each entry is appended after the last bullet of its heading's section (heading matched case-insensitively). A missing
   section is created as `### <Heading>`, a blank line, then the bullets. It goes before the first existing **known**
   section that comes later in `CHANGELOG_HEADINGS`, otherwise after the last section. Unknown sections stay where they
   are.
7. Rebuild the file from `lines[0..start]`, the original Unreleased heading line, a blank line, the preamble (if any)
   plus a blank line, the sections, a blank line if `tail` is not empty, then `tail`. Join with the file's EOL.
8. Self-check before returning: the text before the block and from `end` on is byte-identical to the input,
   `splitUnreleased(out)` is not null, and `checkChangelog(out).errors` is empty. Otherwise return `error` ("internal:
   merge would change text outside Unreleased"). This is a guard, so the tests cover it.

`entryKey`: lowercase, links `[x](y)` -> `x`, drop `` ` * _ ``, non-alphanumerics -> space, collapse spaces, trim.
`isDuplicateEntry(a, b)`: keys are equal, **or** the Jaccard similarity of the sets of words with 3 or more letters is
≥ 0.8 and both have at least 6 such words. This is a deterministic backstop. The model is also told which existing
entries cover which change (section 4.4).

Entry gate, new `packages/shared/src/release/changelog-entries.ts`:

```ts
export type EntryFinding = { code: 'not_public' | 'multi_line' | 'too_long' | 'too_short' | 'ticket_key' | 'sha'
  | 'url' | 'email' | 'ip_address' | 'host_name' | 'secret' | 'deny_list' | 'heading'; detail?: string };
export function scrubChangelogEntry(e: { heading: string; text: string },
  opts: { denyList?: readonly string[]; publicText: (s: string) => string }): EntryFinding[];

export const ChangelogProposalSchema = z.object({
  entries: z.array(z.object({ heading: z.string(), text: z.string().max(2000),
    sources: z.array(z.string().max(60)).min(1).max(50) })).max(60),
  covered: z.array(z.object({ source: z.string().max(60), existing: z.number().int().min(1) })).max(600).default([]),
  skipped: z.array(z.object({ source: z.string().max(60), reason: z.string().max(200) })).max(600).default([]),
});
export const ReleaseChangelogOutputSchema = z.object({ /* section 4.3 output */ });
```

- `not_public`: `publicText(text) !== text` after the gate first trims and collapses runs of spaces. That is exactly
  the "publicText must pass them unchanged" rule. The scrub now runs **on the server** (4.6), so the server passes its
  own `publicText` from `blog/releases.ts`. Moving `publicText` into shared is no longer needed. The builder may still
  do it as a pure move, but it is not required.
- `ticket_key` `\b[A-Z][A-Z0-9]+-\d+\b`, `sha` `\b[0-9a-f]{7,40}\b` with at least one digit and one letter, and `url`,
  `email`, `ip_address`, `host_name`: reuse the regexes from `blog/topic-scrub.ts`. Export them as `SCRUB_PATTERNS`
  rather than copying them, and mask `PUBLIC_TERMS` first so `Node.js` or `Fly.io` pass. `file_path`, `quoted_text`,
  `camel_case`, `snake_case` and `cli_flag` are **not** used: existing entries name settings like
  `AOM_STORAGE_MAX_FILE_BYTES` and paths like `/delivery/releases`.
- `host_name` also flags `localhost`.
- `secret`: `-----BEGIN`, `\b(?:ghp|gho|ghs|github_pat|glpat|xox[abp]|sk|pk)[-_][A-Za-z0-9_-]{12,}`, `AKIA[0-9A-Z]{16}`,
  `(?:password|secret|token|apikey|api_key)\s*[=:]\s*\S+`, any 32+ char run of `[A-Za-z0-9+/=_-]` containing digits and
  letters.
- `deny_list`: whole word, case-insensitive, terms of 3 or more characters, built by the server (agent names of the
  organisation, workstation names and hostnames, environment hostnames, member display names). It is never put into the
  prompt, and the rejection message does not repeat the term ("entry 3 names an internal person, agent or machine").
- `heading` not in `CHANGELOG_HEADINGS`. `multi_line` for any `\n`. Length 20–900 characters (the longest existing
  GuildwiseHQ entry is about 850).

### 4.3 Runner side: the apply handler (file edits in GWP-89's prep worktree)

New `apps/runner/src/git/release-docs-prep-changelog.ts`, registered as `DOCS_PREP_STEP_HANDLERS.changelog` in
`release-docs-prep-steps.ts`. GWP-89's `contentStep` calls it inside the integration worktree, then adds, refuses
extra files and commits to the kept ref. That flow does not change. The handler:

1. `payload.changelog` missing or failing zod -> `{ ok: false, error: 'the server sent no changelog entries: update the
   server' }`.
2. Read `<worktree>/CHANGELOG.md`. ENOENT -> `null`. A path that is not a regular file -> fail
   ("CHANGELOG.md is not a regular file").
3. `md !== null` and `checkChangelog(md, { version })` has errors -> fail the repo with the errors. The server already
   checked the facts copy before any tokens were spent. This re-check covers a branch that moved after the facts read.
4. `entries` empty -> `{ ok: true, files: [] }`, output "no new changes". No file is read further or created.
5. `mergeUnreleased(md ?? changelogSkeleton(projectName), entries)`:
   - `error` -> fail the repo with the message.
   - `unchanged` -> pass with `files: []`. If the file did not exist, it is not created.
   - `merged` -> write `CHANGELOG.md` (utf8) and return `files: ['CHANGELOG.md']`, `created: md === null`.
6. Return `output: { created, added, duplicates, warnings }`. The added entries carry their `sources` from the payload.

This needs a small, generic change in GWP-89's runner and shared code. Extend the handler result to
`{ ok: true; files: string[]; output?: unknown }`, have `contentStep` copy it into `ReleaseDocsPrepResult.output`
(`z.unknown()`, at most 64 KB once serialised, checked on the server), and add `changelog?: ReleasePrepChangelogPayload`
to `ReleaseDocsPrepPayloadSchema`. GWP-91 and GWP-92 reuse `output`.

The handler meets GWP-89's contract ("byte-identical when the content is already on the branch"). On a retry the entries
are already in Unreleased, so `mergeUnreleased` finds them as duplicates and returns `unchanged`.

The handler never runs git add, commit or push itself. GWP-89's `contentStep` and 'commit' do that.

Capability: announce `RELEASE_DOCS_PREP_CHANGELOG_CAPABILITY = 'release-docs-prep-changelog:1'` next to
`RELEASE_DOCS_PREP_CAPABILITY` in `runner.ts` (around line 1434), and bump `RUNNER_VERSION`. The server checks it before
queuing the BA task, so no tokens are spent for a runner that cannot apply the result.

### 4.4 Duplicates and idempotency (three layers)

1. **Source ids, deterministic**: the source ids are the commit SHAs from GWP-89's summary (`commits[].sha`,
   `merges[].sha`). The server builds `coveredSources` from the stored `output` of the `changelog` step in earlier runs
   of the same project, `release_branch` and repo whose run `status = 'passed'` and whose repo row has the same
   `base_tag`. It takes the union of `added[].sources`, `covered[].source` and `skipped[].source`. It also drops commits
   equal to an earlier run's `commit_sha` (the prep commits themselves, which the next analysis lists). On a second run
   every change is covered, so no BA task is queued. The runner gets `entries: []` and the file is not touched. Running
   prep twice on the same release adds nothing.
2. **Model judgement**: the brief lists the existing Unreleased bullets with numbers (from `facts.changelog` via
   `unreleasedBullets`). The model must put a change that an existing bullet already describes into `covered` instead
   of writing it.
3. **Text backstop**: `isDuplicateEntry` in `mergeUnreleased` drops near-identical text, also within one batch, on the
   real file in the worktree.

No hidden ids or HTML comments go into the file: they would show up in `publicText` output and break the "format
unchanged" rule.

### 4.5 Edge decisions

| Case | Behaviour |
|---|---|
| Step off | Not in `run.steps`, so it is never dispatched (GWP-89 `nextReleaseDocsPrepAction`). No BA task, no runner command, the file is never opened. Byte-identical (AC6). |
| 'Analyse changes' off, changelog on | The registry gets an optional `requires: ['analyse']`. `startReleaseDocsPrep` refuses with 409 `release_docs_prep_requires`: "Write changelog needs Analyse changes. Turn it on in the project settings." Backstop at dispatch: no `summary` means the step fails with the same sentence. The settings checklist shows the hint under the step. |
| Repo with no changes (`commitCount` 0, or everything covered) | No BA task. The runner gets `entries: []` and passes with "no new changes". No file is created. |
| No CHANGELOG.md and changes | The runner creates the skeleton plus the entries. `releaseChangelog` / `splitUnreleased` parse it (AC3). |
| Malformed file | The server fails the step from `facts.changelog` before queuing the BA task. Otherwise the runner fails it on the real file. GWP-89 then commits nothing and the gate keeps ship blocked (AC7). |
| Undated `## [x.y.z]` pending section | Fail with the move-it-under-Unreleased message (section 2.3). The file is not edited. |
| Unknown `###` heading in Unreleased | Warning in the output, not a failure (written by hand; editing it would rewrite someone's text). |
| BA proposal invalid | The report is rejected with the findings and the BA fixes it in the same shift. A `release-changelog-fail` report, a timeout or a crash runs the fallback, which fails the step with the BA's note or "the changelog writer did not finish". Nothing is written. |
| No BA can take the task | The BA-task dispatcher's normal wait and fallback apply. The step fails with "no BA is available to write the changelog". The run fails, and Retry is available. |
| Run skipped or failed while the BA works | The report is accepted, the task is closed as `cancelled`, and no runner command is sent (the run is no longer `running`). |
| CRLF file | Kept CRLF. Trailing newline kept as found. |

### 4.6 Server side

New `apps/server/src/release/docs-prep-changelog.ts`, beside `docs-prep.ts`:

- **Registry** (shared `docs-prep.ts`): `CHANGELOG_STEP = { id: 'changelog', label: 'Write changelog', description:
  'Writes user-facing entries for the analysed changes into the Unreleased section of each repository's CHANGELOG.md.',
  order: 20, defaultOn: true, producesFiles: true, requires: ['analyse'] }`, appended to `STEPS`. Add `requires?:
  string[]` to `ReleaseDocsPrepStepDef`. The settings DTO lists it, and `startReleaseDocsPrep` refuses a run whose
  enabled steps miss a required one.
- **Dispatch hook in `advance()`**: before building the runner payload, `if (action.step === 'changelog') return
  dispatchChangelog(ctx, tx, run, repo, basePayload)`. It:
  - fails the step (`ReleaseDocsPrepStepFinished` failed) when there is no summary, when the workstation lacks the
    changelog capability, or when `checkChangelog(facts.changelog)` has errors. The facts copy is used only when
    `facts.headSha === summary.headSha`; otherwise the runner's re-check decides.
  - computes `uncovered` (4.4 layer 1). If it is empty, it enqueues the runner command with `changelog: { projectName,
    entries: [] }`.
  - otherwise appends `ReleaseDocsPrepStepStarted` (no `commandId`) and `BaTaskQueued { kind: 'release_changelog',
    prepRunId, repoId }`. Guard: one open task per (run, repo).
- **BA task kind `release_changelog`**: a migration adds the kind to `ba_tasks_kind_check` and adds
  `prep_run_id uuid, prep_repo_id uuid` columns, and the `phases` projection stores them.
  - `BaTaskKind` in `packages/shared/src/phases/index.ts` gets the new kind. `baTaskBriefOutcomes`:
    `release_changelog_done` / `release_changelog_fail`.
  - `buildReleaseChangelogTask` gives the repo name, the project name, the numbered uncovered changes (commit and merge
    subjects, card titles looked up by key in `cards`, since GWP-89 leaves `title: null`, and areas, but **no** author
    names), the numbered existing Unreleased bullets, and the playbook step file to follow.
  - `applyReleaseChangelogReport` (wired in `commands/ba-tasks.ts` like `spec_card`) validates `report.data` with
    `ChangelogProposalSchema`, normalises headings (case), and runs `scrubChangelogEntry` with the server's `publicText`
    and deny list. Findings reject the report with one line per finding. A clean report finishes the task, stores the
    proposal on the task, and enqueues `release.docs_prep` with `changelog: { projectName, version?, entries,
    proposal: { covered, skipped } }`. It then calls `deliverPending`.
  - `runReleaseChangelogFallback` fails the prep step and advances the run, which fails it.
  - `aom` verbs in `apps/runner/src/aom/aom-cli.ts`: `release-changelog --file <json>` (data = parsed file) and
    `release-changelog-fail --note`.
- **Output storage** (generic, for GWP-91/92 too): a migration adds `output jsonb` to `release_docs_prep_steps`. Add
  `output` to `ReleaseDocsPrepResultSchema`, the `ReleaseDocsPrepStepFinished` event (optional), the projection and
  `ReleaseDocsPrepRunDto.repos[].steps[]`. For `changelog`, `applyReleaseDocsPrepResult` stores
  `ReleaseChangelogOutputSchema.parse({ ...runnerOutput, covered, skipped })` (the proposal's covered and skipped from
  the payload) and drops it if it fails the schema. Live updates use GWP-89's existing realtime invalidation, with no
  new subscription.
- `ReleasePrepChangelogPayloadSchema` and `ReleaseChangelogOutputSchema` live in `packages/shared/src/release/`.

### 4.7 Web: Releases page step output

In `apps/web/src/components/delivery/ReleaseDocsPrepTab.tsx`, add a renderer for step `changelog` that reads
`step.output` per repo:

- A summary line: "GuildwiseHQ: 3 entries added (Added 1, Fixed 2)", "guildwise-cloud: CHANGELOG.md created, 2 entries
  added", "No new changes", "Writing entries…" (running, BA task open), or the error text (failed state, same red
  treatment as the other steps).
- Expanded: entries grouped under their heading, as plain text (React text nodes, no HTML injection). Then
  "Already in the changelog" (duplicates and covered, collapsed), "Not written" (skipped with reason) and warnings.
- Touch: the expand control is a real `<button>` with an `aria-expanded` state and at least a 44px target. Nothing is
  hover-only. Long entries wrap (no horizontal scroll at 360px). It is read-only, so no soft-keyboard concerns.
- `ReleaseDocsPrepPanel.tsx`: the checklist shows "Needs Analyse changes" under Write changelog when Analyse is unticked.

## 5. Files to change

| # | File | Change |
|---|---|---|
| 1 | `packages/shared/src/release/changelog-rewrite.ts` | add `CHANGELOG_HEADINGS`, `checkChangelog`, `changelogSkeleton`, `unreleasedBullets`, `mergeUnreleased`, `entryKey`, `isDuplicateEntry` (export or reuse `linesOf`). Existing functions unchanged. |
| 2 | `packages/shared/src/release/changelog-entries.ts` (new) | `scrubChangelogEntry`, `ChangelogProposalSchema`, `ReleasePrepChangelogPayloadSchema`, `ReleaseChangelogOutputSchema` |
| 3 | `packages/shared/src/blog/topic-scrub.ts` | export the existing regexes as `SCRUB_PATTERNS` (no behaviour change) |
| 4 | `packages/shared/src/release/docs-prep.ts` | `CHANGELOG_STEP` in `STEPS`, optional `requires` on the def |
| 5 | `packages/shared/src/release/docs-prep-dto.ts`, `events/release-docs-prep.ts`, `release/index.ts`, `protocol/runner.ts` | payload `changelog`, result and event `output`, run DTO step `output`, `RELEASE_DOCS_PREP_CHANGELOG_CAPABILITY`, exports |
| 6 | `packages/shared/src/phases/index.ts` | `BaTaskKind` `release_changelog`, brief type, outcomes |
| 7 | `apps/server/migrations/<next>_release_docs_prep_output.sql` | `release_docs_prep_steps.output jsonb`, `ba_tasks` kind + `prep_run_id`/`prep_repo_id` |
| 8 | `apps/server/src/release/docs-prep.ts`, `projections/release-docs-prep.ts`, `projections/phases.ts` | `requires` check at start, dispatch hook for `changelog`, store and serve `output` |
| 9 | `apps/server/src/release/docs-prep-changelog.ts` (new) | `dispatchChangelog`, covered sources, deny list, `buildReleaseChangelogTask`, `applyReleaseChangelogReport`, `runReleaseChangelogFallback` |
| 10 | `apps/server/src/commands/ba-tasks.ts`, `dispatcher/ba-tasks.ts`, `runner-gateway/ba-task-brief.ts` | wire the new kind like `spec_card` |
| 11 | `apps/runner/src/git/release-docs-prep-changelog.ts` (new), `release-docs-prep-steps.ts`, `release-docs-prep.ts` | the apply handler. The handler result `output` is passed through `contentStep` |
| 12 | `apps/runner/src/runner.ts`, `aom/aom-cli.ts`, runner version | capability, `release-changelog` / `release-changelog-fail` verbs, `RUNNER_VERSION` bump |
| 13 | `packages/capabilities/playbooks/release-notes/steps/step-changelog-unattended.md` (new) + `workflow.md` | the unattended prompt (section 5.6). `workflow.md` gets a short "Unattended (release prep)" note pointing to it. Interactive steps unchanged. |
| 14 | `apps/web/src/components/delivery/ReleaseDocsPrepTab.tsx`, `ReleaseDocsPrepPanel.tsx` | output renderer (4.7), requires hint |
| 15 | docs: `USER-GUIDE.md` / `RUNNER.md` / `ARCHITECTURE.md` release prep sections, `CHANGELOG.md` Unreleased entry | short paragraphs |

### 5.6 The unattended prompt (playbook step file content, in outline)

- Role: write the public changelog entries for one repository from the change list given. No questions, no owner.
- Input: repository name, numbered changes (subject, merged card titles, areas), numbered existing Unreleased entries.
- Rules: the format in section 3 (headings, one line, verb-led, reader's words). Map the playbook groups: New -> Added,
  Improved -> Changed, Fixed -> Fixed, Upgrade notes -> Changed with "Upgrade:" in front, Behind the scenes -> not
  written (`skipped`, reason "internal"). Never mention tickets, commits, hosts, people, agents, reviews or the way the
  work was done. One entry may cover several changes (list all their sources). A change an existing entry already
  describes goes to `covered` with that entry's number. Every change must end up in exactly one of `entries[].sources`,
  `covered` or `skipped`.
- Output: write the JSON to a file in the scratch folder and report it with `aom release-changelog --file <path>`. If
  the report is rejected, fix the entries named and report again. Do not edit any repository.

## 6. How each acceptance criterion maps to the design

| AC | Covered by | Test |
|---|---|---|
| Two repos: entries under Unreleased in each, output lists them per repo | Per-repo BA task + runner apply. `output` stored per step and repo. 4.7 renderer | Server: dispatch queues one task per repo, and an accepted report enqueues the command with the entries. Runner: handler on two temp repos. Web renderer unit test. E2E (testers) |
| Existing entries preserved, not duplicated | `mergeUnreleased` keeps the block and appends. 4.4 three layers | shared: partly filled, duplicates (exact and near), same-batch duplicate. Server: second run with covered sources -> no BA task, `entries: []`. Runner: entries already present -> `files: []` |
| No CHANGELOG.md -> created, parses | `changelogSkeleton` + merge. Self-check | shared: skeleton prefix equals `newChangelog`. `splitUnreleased` / `releaseChangelog` on the result -> `rewritten`. Server parity test: `parseUnreleased` count |
| Ship builds the release section from the new entries, ship code unchanged | Only Unreleased edited. Format = `SECTION_OF` headings. `checkChangelog` blocks the undated pending heading. GWP-89 commits to the ship branch and refreshes facts | shared round trip: merge -> `releaseChangelog` -> section contains the entries. Server: `buildProposal` / `previewSection` on the merged file. No diff in `ship.ts` / `release-ship.ts` |
| Public page shows the entries after publish | Headings in `SECTION_OF`, `publicText(e) === e` gate | server: merge -> `releaseChangelog` -> `buildReleases` shows each entry unchanged |
| Step disabled -> byte-identical | Not in `run.steps`, never dispatched | shared: `enabledReleaseDocsPrepSteps` without changelog. Server: run with the step off sends no `changelog` command and queues no task. Runner: handler not called |
| Malformed file -> clear error for that repo, nothing committed, ship blocked | `checkChangelog` on the server (facts) before the model, and on the runner. Fail -> GWP-89 commits nothing and keeps the gate | shared: each malformed case returns its sentence. Server: facts with an undated heading -> step failed, no task. Runner: failed result, file untouched |

Test plan (builder runs unit tests only):

- shared `changelog-rewrite.test.ts` / `changelog-entries.test.ts`: empty, partly filled, duplicates, new file, round
  trip, malformed, CRLF, tight and loose style, new heading order, unknown heading kept, bytes outside the block equal,
  scrub codes, publicText parity, registry order and `requires`.
- server: `release-changelog-parity.test.ts` cases for the merged file. `release-docs-prep-changelog.test.ts` covers
  dispatch (no summary, missing capability, malformed facts, nothing uncovered, task queued), report rejection with
  findings, a deny-list hit not echoed, an accepted report enqueuing the command, fallback failing the run, covered
  sources from an earlier passed run, and output stored and served.
- runner `release-docs-prep-changelog.test.ts`: temp repo, two repos, created file, idempotent second apply, malformed
  file, output passed through `contentStep`.
- web renderer test.

E2E stays for the testers (`e2e/**`): extend `e2e/tests/release-docs-prep.spec.ts`.

## 7. Options compared

| | A: model edits CHANGELOG.md directly | **B: model proposes JSON, code merges (chosen)** | C: no model, entries from commit subjects |
|---|---|---|---|
| Only Unreleased edited | trust the model, check after | guaranteed by construction + self-check | guaranteed |
| Format / headings right | often wrong (the playbook's own headings break it) | enforced | enforced |
| Public, no chatter or secrets | check after, hard to repair | gate per entry + repair round | commit subjects are internal ("chore: pin core") — fails req. 4 |
| Idempotent | weak | source ids + text | strong |
| User-facing quality | good | good | poor |

Where the model runs (new after the GWP-89 review):

| | **BA task (`ba_tasks`, chosen)** | Headless model call inside the runner command | New agent shift kind for prep |
|---|---|---|---|
| Exists today | yes (`spec_card`, `mail_reply_draft`): queue, dispatcher, brief, report with data, rejection = repair, fallback | no. `startChat` is wired only into `ChatManager` and needs an agent spec, sandbox and account the command does not have | no |
| Login and tokens | the BA's own login on the user's workstation (standing order) | would need agent and account selection inside a git command | same as BA task |
| Effort | one new kind, wired like `spec_card` | new infrastructure in the runner | most |

Undated pending `## [version]` section: **fail with a clear message (chosen)**, rather than fold it into Unreleased
automatically (that edits outside Unreleased, which the card forbids) or write into it (ship would never date it, and
the public page drops it).

## 8. Risks

- **GuildwiseHQ release/1.5.0 has an undated `## [1.5.0]` today**: prep on 1.5.0 fails on that repo until the owner
  moves those entries under Unreleased. Ship has the same problem today (it would report "already done" and never date
  1.5.0). This is raised with the owner separately. It is not a defect of this step.
- Model quality: bad entries are blocked, not fixed silently. The BA gets the findings and fixes them in the same shift.
  A fail report or timeout fails the step. The owner can edit the file by hand and use GWP-89's Retry or Skip.
- A BA task waits for a free BA. The step shows "Writing entries…" meanwhile, and the BA dispatcher's normal timeout
  applies.
- The facts copy of `CHANGELOG.md` may lag the branch. The runner re-checks and deduplicates on the real file, so a lag
  only costs tokens, never a wrong write.
- False positives in the scrub (for example a time "10:30" read as host:port). The finding names the fragment. The
  pattern set is kept small on purpose.
- `advance()` and `applyReleaseDocsPrepResult` change in GWP-89's module. Keep the change to one dispatch hook and the
  `output` pass-through, and GWP-89's tests guard the rest.

## 9. Assumption review against the landed GWP-89 (2026-11-04)

| # | Assumption | Verdict | What the code shows / what changed |
|---|---|---|---|
| 1 | Step registry with key, order, default-on; disabled steps not run at all | **holds** | `ReleaseDocsPrepStepDef { id, label, description, order, defaultOn, producesFiles }` in shared `docs-prep.ts`. `run.steps` is frozen from `enabledReleaseDocsPrepSteps` at start, and `nextReleaseDocsPrepAction` iterates only those. Register as `CHANGELOG_STEP` (id `changelog`, order 20, `producesFiles: true`) plus `DOCS_PREP_STEP_HANDLERS.changelog`. |
| 2 | Analyse output per repo lists items with stable source ids that later steps get | **holds** | `ReleaseDocsPrepSummarySchema`: `commits[].sha`, `merges[].sha/cardKeys/prNumber`, `cards[].key`. It is sent in the payload of every later step. Notes: `cards[].title` is `null` (the brief builder looks titles up), commits are capped at 300 (`commitsTruncated`), and the next analysis also lists the prep commit (excluded via earlier `commit_sha`). |
| 3 | Steps can declare `requires`, or GWP-89 refuses a run with Analyse off | **does not hold** | No `requires`, and a run with Analyse off starts, so the content step gets no `summary`. Add optional `requires` to the def, refuse at start, keep the dispatch-time backstop (4.5, 4.6). |
| 4 | Runner steps run per repo in a throwaway prep worktree and can run a model task writing to a scratch dir | **partly holds** | Worktree: yes (`withIntegrationWorktree` from the kept work ref). Model: **no**. `DocsPrepStepHandler` gets `{ worktree, payload, summary }` only, and model work runs only in agent shifts or chats. Changed to a BA task `release_changelog` for the proposal, with the runner handler as the deterministic apply (4.1, 4.3, 4.6). |
| 5 | Commit results commits the step files only when every step passed in every repo, to the branch ship releases from | **holds** | `docsPrepRepos` uses `repoReleaseBranch` = `r.working_branch ?? p.working_branch`, the same as ship's `COALESCE(r.working_branch, p.working_branch)`. Any failed step finishes the run as failed before `commit`. Two-phase prepare/push. |
| 6 | Facts refreshed after the prep push and before the ship gate opens | **holds** | `applyReleaseDocsPrepResult` calls `requestReleaseFacts` for every repo with a commit when the run passes. `releaseDocsPrepGate` refuses until the facts contain the prep commit. |
| 7 | Step results stored per run, step and repo as JSON, sent over realtime, earlier runs readable | **does not hold** | `release_docs_prep_steps` stores `files` and `error` only. The result's `notices` are dropped, and the DTO has no output. Earlier runs are readable. Add a generic `output jsonb` column, carried through result, event, projection and DTO, and build `coveredSources` from earlier passed runs' `changelog` output (4.4, 4.6). |
