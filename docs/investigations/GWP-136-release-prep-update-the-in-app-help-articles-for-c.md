# GWP-136 Release prep: update the in-app Help articles for changed features

Status: design, ready to build **after GWP-134 has merged** (see 2, 7). Base: `release/1.6.0`. The checkout is at
3f50ba05, which is the same commit as `origin/release/1.6.0`, so everything below was read on the 1.6.0 code.

## 1. Question

The 'Update user guide' prep step (GWP-91) edits only `docs/USER-GUIDE.md` (and rebuilds the PDF from `docs/guide/`).
The in-app Help articles (`apps/web/src/help/articles/*.md`) are written by hand, so after a release they drift away from
the guide. The card asks for a prep step, or an extension of the guide step, that updates the Help sections for the
features changed in the release. It must keep every `{#id}` anchor, keep the frontmatter valid, write nothing outside the
articles folder, and report what it changed.

## 2. R0: what release/1.6.0 already does (owner instruction)

| Question on the card | State on release/1.6.0 | Evidence |
| --- | --- | --- |
| Does the guide step or any other prep step write to `apps/web/src/help/articles/`? | **No.** `runGuideStep` writes only the guide file, plus the files that the PDF build creates under `docs/guide/`. Any other changed path fails the step (`the guide build changed …`). It reads the Help folder only to check `/help/<slug>#<id>` links in new guide text (`helpRef`). | `apps/runner/src/git/release-docs-prep-guide.ts:161-173, 326-330` |
| Do `guideCoveredSources` / `guideOutputSources` include the Help articles? | **No.** Both deal with change ids (`card:`, `merge:`, `commit:`) from the guide step's output. No Help file or Help output is involved. | `packages/shared/src/release/user-guide.ts:696`, `apps/server/src/release/docs-prep-steps.ts:27` |
| Is there a separate Help-article step? | **No.** The registry is `analyse`, `changelog`, `guide`, `videos`, `commit`. | `packages/shared/src/release/docs-prep.ts:78`, `apps/runner/src/git/release-docs-prep-steps.ts:74` |
| Does `phases.md {#release-prep}` mention Help articles? | **No.** It lists the five steps only. | `apps/web/src/help/articles/phases.md:102-104` |

**Conclusion:** none of this card exists on release/1.6.0, so there is nothing to close. The whole card is built. The
planner reached the same result.

**Work in flight that matters:** GWP-134 ("one writer mechanism for the content steps", stage build, branch
`aom/gwp-134-…`, design commit aac8e78c) rewrites how the guide step gets its text. The headless `runModel` call is
removed. The guide becomes the phases `check` (runner), `write` (server, a `release_prep` task of kind `guide_edits`) and
`apply` (runner). Its section 7 defines how a new content step plugs in. This card is designed on top of that mechanism
(see 4 and 7). Building it on today's headless path would add a fourth writer path, which GWP-134 deletes, and it would
conflict with GWP-134 in the same files. The card is therefore blocked on GWP-134 (dependency).

## 3. Findings that drive the design

1. **The Help format is not the guide format.** The guide parser and edit helpers (`parseGuide`, `resolve`,
   `applyGuideEdits`, `checkGuideUpdate`) are built around one file with numbered `## 4.` / `### 4.28` headings, a
   generated contents block, section numbering (4.28a) and a PDF build. A Help article is different:
   - YAML-like frontmatter (`title`, `summary`, `keywords`, `order`), read by `parseFrontmatter` in
     `apps/web/src/help/markdown.ts:32`;
   - `##` / `###` headings with an optional `{#id}`. The heading regex is
     `/^(#{2,3})\s+(.*?)(?:\s*\{#([a-z0-9-]+)\})?\s*$/`, the id defaults to `slugify(text)`, and a repeated id becomes
     `id-2`, `id-3` (`markdown.ts:104-111`). Headings inside fenced code are ignored;
   - no numbers, no contents block, 38 files.

   So `applyGuideEdits` and `checkGuideUpdate` cannot be called on Help files as they are. What carries over is their
   **design**: whole-or-nothing edits, idempotent duplicates, heading lines never rewritten, a self-check that every
   heading is still in place, checks limited to the lines written, and size limits. Two helpers can be reused directly:
   `scrubGuideText` (ticket keys, commit ids, secrets, deny list) and `guideWords` (locate hints).
2. **The `id` of a heading without `{#…}` can shift.** If a new heading with the same slug is inserted *before* it, the
   old heading becomes `id-2`. So the check must compare the **effective** ids of every pre-existing heading (explicit or
   derived), not only the explicit `{#id}` strings.
3. **Who links to the anchors.** The guide (`/help/<slug>#<id>`), `pageHelp`, `HelpHint`, the tour, What's New and the
   articles themselves. `apps/web/src/test/help.test.tsx:82,115` already checks on the real files that every such link
   resolves. If no anchor disappears or shifts, these links keep working by construction.
4. **Change items and coverage already exist.** `guideChangeItems(ctx)` (runner, exported) turns the analyse summary
   into one item per merge or commit, with sources, title, files, areas and routes. The guide's covered-sources
   pattern, with change ids stored in the step output and read back by the next run, fits a Help step unchanged.
5. **The Prep UI and settings are generic.** The settings list, the toggle, the per-step state, Run, Retry and Skip all
   come from `releaseDocsPrepSteps()` (`apps/server/src/release/docs-prep.ts:88-116`,
   `apps/web/src/components/ReleaseDocsPrepPanel.tsx:71-90`). A new registry entry shows up and can be switched on and
   off with no UI change. Only the output view (`ReleaseDocsPrepTab.tsx:205`) is per step.
6. **Failure means nothing is committed.** `keepWork` returns `failed` before `git add` when the handler says
   `ok:false` (`apps/runner/src/git/release-docs-prep.ts:373`), and a failed row fails the run, so the `commit` step
   never runs.

## 4. Options (placement, requirement 4)

| | (a) Extend 'Update user guide' | **(b) New step 'Update Help articles'** |
| --- | --- | --- |
| Switch on/off per project | No: Help comes with the guide | Yes, like every other step |
| Format and checks | One proposal covering two formats. The guide check path (contents block, numbering, PDF) grows a second branch for Help | Its own small parser and check in one new module. The guide code is not touched |
| Retry cost | A Help refusal reruns the guide writer and the PDF build (pnpm install, Playwright) | A Help retry reruns only the Help writer |
| Failure isolation | A Help problem fails the guide step | A Help problem fails only the Help step (the run still fails, but the row says which part) |
| Writer work | One shift writes both (slightly cheaper) | One more `release_prep` shift per release with Help-relevant changes |
| Consistency with the guide | The same writer sees both | The step runs after the guide, so its worktree already contains the updated guide. The playbook tells the writer to keep both consistent |
| Merge risk | High: GWP-134 is rewriting `runGuideStep` and the guide proposal path, and GWP-161 changes the guide path | Low: new files plus one registry entry in each layer |
| "No second parallel mechanism" constraint | Met | Met: it is a GWP-134 content step (`PREP_TASK_KINDS` entry and the same phases), with no new writer path |

## 5. Decision

**Option (b): a new, separately switchable step `help`, "Update Help articles".** It is a content step on the GWP-134
mechanism (phases `check` → `write` → `apply`, writer kind `help_edits`). Reasons: it can be switched per project, it
has its own checks for a different format, a retry is cheap, it does not touch the guide step that GWP-134 and GWP-161
are changing, and it adds no writer path.

Step definition:

```ts
// packages/shared/src/release/docs-prep.ts
export const HELP_STEP: ReleaseDocsPrepStepDef = {
  id: 'help',
  label: 'Update Help articles',
  description:
    'Updates the in-app Help article sections for the changed features. Keeps every section anchor and the article ' +
    'headers. Needs Analyse changes.',
  order: 35,                      // after guide (30): the writer sees the updated guide; before videos (40)
  defaultOn: true,                // same as guide; a repository without Help articles is skipped (no writer)
  producesFiles: true,
  requires: ['analyse'],
  phases: ['check', 'write', 'apply'],
  serverPhases: ['write'],
  writerPhase: 'write',           // added to the type by GWP-134
};
const STEPS = [ANALYSE_STEP, CHANGELOG_STEP, GUIDE_STEP, HELP_STEP, VIDEOS_STEP, COMMIT_STEP];
```

Why `defaultOn: true`: the card's goal is that "when release docs prep runs" the Help articles are kept up to date. A
project that saved its settings before keeps its stored ticks, and `help` is not in them, so it gets the default. A
repository with no Help folder skips in `check`, with no writer and no cost (GWP-134 R5 rule). If the owner prefers
opt-in, changing it to `false` is a one-word change; the builder does not need to ask.

The Help folder is a step input, `helpDir`, default `apps/web/src/help/articles`, sent by the server like `guidePath`.
This card makes no setting for it. GWP-161 (per-repository guide path) can add one the same way later.

## 6. Design for the builder

### 6.1 Shared: new `packages/shared/src/release/help-articles.ts` (pure, exported from the index)

```ts
export const DEFAULT_HELP_DIR = 'apps/web/src/help/articles';

export interface HelpHeading { line: number; level: 2 | 3; raw: string; text: string; explicitId: string | null; id: string }
export interface HelpSection { heading: HelpHeading; bodyStart: number; end: number } // end = next ## or ### heading, or EOF
export interface HelpArticleDoc {
  lines: string[]; eol: '\n' | '\r\n'; finalEol: boolean;
  frontmatter: { start: number; end: number } | null;   // the two '---' lines
  meta: { title?: string; summary?: string; keywords?: string; order?: string };
  headings: HelpHeading[]; sections: HelpSection[];
}
export function parseHelpArticle(md: string): HelpArticleDoc;
```

- **Parity with the app reader.** Copy the heading regex, `slugify`, the `-2` dedupe and the code-fence skip exactly from
  `apps/web/src/help/markdown.ts`. Do not change the web code. A web test (section 8, Web 1) pins that
  `parseHelpArticle(src)` gives the same ids, in the same order, as `buildArticle(slug, src).headings` for every real
  article. Any later drift then fails a test.
- Edits (the writer's JSON). `article` is a slug, never a path, so a write outside the folder cannot be expressed:

```ts
const Slug = z.string().regex(/^[a-z0-9-]+$/).max(80);
const Id = z.string().regex(/^[a-z0-9-]+$/).max(80);
export const HelpEditSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replace_text'), article: Slug, section: Id, find: z.string().min(1).max(4000),
             replace: z.string().max(4000), sources }),
  z.object({ op: z.literal('append'), article: Slug, section: Id, text: z.string().min(1).max(6000), sources }),
  z.object({ op: z.literal('add_section'), article: Slug, after: Id, title: z.string().min(1).max(120), id: Id,
             level: z.union([z.literal(2), z.literal(3)]).optional(), body: z.string().min(1).max(8000), sources }),
]);
export const HelpProposalSchema = z.object({
  edits: z.array(HelpEditSchema).max(30).default([]),
  covered: z.array(z.object({ source: z.string().max(80), article: Slug, section: Id })).max(500).default([]),
  skipped: z.array(z.object({ source: z.string().max(80), reason: z.string().max(300) })).max(500).default([]),
  notes: z.array(z.string().max(500)).max(50).default([]),
});
```

- `applyHelpEdits(files: Record<string, string>, edits): ApplyHelpOutcome`. `files` maps slug to content.
  - Returns `{kind:'changed', files /* only the changed slugs */, changed: {article, section}[], added: {article,
    section, after}[], duplicates, written: Record<slug, [number, number][]>}`, or `unchanged`, or `error`.
  - Same rules as `applyGuideEdits`: all edits or none; an edit already present counts as a duplicate, so a second run
    changes nothing; `find` must occur exactly once in the section body.
  - Sections are resolved by effective `id`.
  - `add_section` writes `${'#'.repeat(level ?? after.level)} ${title} {#${id}}` after the end of the `after` section,
    or after its last `###` child when the new section is level 2.
  - Text rules for `replace`, `text` and `body`:
    - no `#`, `##` or `###` heading lines (`####` is allowed in `body`);
    - no `{#`;
    - no `---` line;
    - no HTML comments;
    - no fenced blocks, because a stray fence would hide the headings after it from the app reader.
  - Errors:
    - `unknown article "x"`;
    - `unknown section "x#y"`;
    - `the id "y" is already used in x`, when it clashes with any effective id;
    - `the title must be one line of text`.
  - Self-check before returning: every heading line of the input is still present, in order.
- `checkHelpUpdate(before: Record<string,string> | null, after: Record<string,string>, ctx: HelpCheckContext)` returns
  `{errors, warnings}`. `ctx` has `changedRanges?`, `editedSections?`, `addedSections?` and `denyList?`. A problem
  already present in `before` is a warning, not an error (same as the guide). Errors:
  - **Articles:** a slug in `before` that is missing from `after` (`the article x would be removed`), or a new slug
    (`the update would create the article x`).
  - **Frontmatter:**
    - the frontmatter lines must be byte-identical (`the header of x was changed`);
    - after the update, `title` and `order` must still be present and the `---` block must still match the
      `parseFrontmatter` regex (`the header of x is no longer valid`).
  - **Anchors:**
    - every heading line in `before` is still in `after`, in order;
    - **every (slug, effective id) in `before` is in `after` with the same id**
      (`the anchor x#y would be removed or renamed`);
    - no explicit `{#id}` is used twice in an article (`two headings in x share the anchor #y`);
    - every new heading has an explicit `{#id}` (`the new section "T" in x has no anchor`).
  - **Links and text** (written lines only):
    - `/help/<slug>#<id>` and `(#id)` links must resolve against `after`;
    - `scrubGuideText` findings (`the new text contains …`).
  - **Size:** more than 8 edited sections, more than 4 added sections, or more than 40 % of an article's lines written
    gives `the update would rewrite too much of x`.
- `locateHelpSections(docs: Record<slug, HelpArticleDoc>, feature): {article, section, score, why}[]`.
  - Uses `guideWords` (and exports `pathWords` from `user-guide.ts`) against:
    - the article title, keywords and summary (weight 2);
    - section titles (3);
    - bold labels in the body (1);
    - backticked routes `/…` in the body (2).
  - These are hints, not a gate.
- Step input and output schemas (mirror the guide's):

```ts
export const ReleaseDocsPrepHelpInputSchema = z.object({
  helpDir: z.string().min(1).max(300).default(DEFAULT_HELP_DIR),
  coveredSources: z.array(z.string().max(80)).max(2000).default([]),
  denyList: z.array(z.string().max(100)).max(200).default([]),
});
export const ReleaseDocsPrepHelpOutputSchema = z.object({
  status: z.enum(['passed', 'failed']),
  skipped: z.literal('no help articles').optional(),
  nothing: z.string().max(200).optional(),
  changed: cap(z.object({ article: z.string().max(80), title: z.string().max(200), section: z.string().max(80),
                          heading: z.string().max(200), sources })),
  added:   cap(z.object({ article, title, section, heading, after: z.string().max(80), sources })),
  covered, skippedChanges, duplicates, errors, warnings, notes,   // as in the guide output
});
export function helpOutputSources(output: unknown): string[];     // as guideOutputSources
```

- **GWP-134 registry** (`docs-prep-task.ts`):
  - Add `HelpEditsTaskSchema = { kind:'help_edits', helpDir, changes (with hints), coveredSources }` to the
    `ReleasePrepTaskSchema` union.
  - Add `PREP_TASK_KINDS.help_edits = { roles: ['architect','ba','builder'], result: 'proposal', what: () => 'the Help
    article update' }`.
  - `writableFilesFor` → `[PREP_PROPOSAL_FILE]`.
  - `renderReleasePrepInstructions` / `Prompt` for `help_edits` use a new built-in playbook `help-articles`
    (`packages/capabilities/playbooks/help-articles/`, next to `user-guide`). Its rules:
    - edit only the sections whose feature changed;
    - match the released behaviour and the updated user guide in this worktree;
    - plain Help style;
    - never touch headings, anchors or headers;
    - a new section only for a new user-visible feature, with a new lowercase id;
    - list every change source as covered or skipped;
    - write `release-prep-proposal.json` and change no other file.

### 6.2 Runner: new `apps/runner/src/git/release-docs-prep-help.ts`

- Register `help: runHelpStep` in `DOCS_PREP_STEP_HANDLERS`.
- Shared helpers, used by both the `apply` phase and GWP-134's `finishPrepProposal`, so the check is one piece of code:
  - `readHelpArticles(wt, helpDir): Record<slug, string>` reads the direct `*.md` children only.
  - `helpCheckContext(files, denyList)`.
  - `tryHelpEdits(before, edits, ctx)` = `applyHelpEdits` + `checkHelpUpdate(before, after, {changedRanges…})`.
- `runHelpStep` by `ctx.phase`:
  - **`check`**
    1. Parse the input. Refuse an absolute `helpDir` or one with `..` (fail).
    2. No folder, or no `*.md` in it: return
       `{ok:true, state:'skipped', note:'skipped: no Help articles in this repository', output:{…empty, skipped:'no help articles'}}`.
    3. No summary: fail with `Update Help articles needs Analyse changes: tick it in the release prep settings`.
    4. Pre-check with `checkHelpUpdate(null, files, ctx)`. Errors fail with
       `the Help articles have problems before the update: <first>`.
    5. Collect the uncovered items: `guideChangeItems(ctx)` minus `coveredSources`.
    6. **Relevant** items are uncovered items that have at least one hint, or that change a file of the app that owns the
       Help folder (the `helpDir` prefix up to `/src/`, so `apps/web/`). The second case lets a new feature get a new
       section.
    7. No relevant items: passed, with report `{changes: []}` and note `no changed area is covered by a Help article`.
    8. Otherwise: passed, with report `{helpDir, changes}` (top 3 hints each), capped to `REPORT_MAX_BYTES`.
  - **`apply`**
    1. No `input.proposal`: passed with `nothing:'no new changes'`, no files.
    2. Otherwise run `tryHelpEdits` on the real files. Errors fail with
       `the Help update was refused: <first>`, with all errors in the output. **Nothing is written.**
    3. `unchanged`: passed with `nothing:'no Help change needed'`.
    4. `changed`: write only the changed slugs.
    5. Run `changedPaths(wt)`. Any path that is not `<helpDir>/<slug>.md` fails with
       `the Help update changed files outside <helpDir>: …`. This is defence in depth: `keepWork` also refuses
       unexpected files.
    6. Return `files` and the output with `changed`/`added`, where `title` and `heading` are read from the article for
       the result list.
  - **Phase `''`:** fail with `this runner needs a newer server for Update Help articles: update the server`.
- **Old runners.** A runner without the handler already fails with
  `this runner has no handler for the step 'help': update the runner` before any writer is queued, because `check` is
  the first phase and it runs on the runner. GWP-134's `writerStepGate` also applies (`writerPhase` is set). No new
  capability is needed.

### 6.3 Server (`apps/server/src/release/`)

- `docs-prep-steps.ts`:
  - Generalise `guideCoveredSources` into
    `stepCoveredSources(db, run, repoId, step, sourcesOf)`. Rows are read with
    `s.step=$step AND s.phase IN ('','apply')`.
  - Keep `guideCoveredSources` as a wrapper and add `helpCoveredSources`.
  - Add the hook:
    `help: { stepInput: async (db, run, repo) => ({ helpDir: DEFAULT_HELP_DIR, coveredSources: await helpCoveredSources(db, run, repo.repo_id), denyList: [] }) }`.
    GWP-134 applies `stepInput` to every phase.
- `docs-prep-writer.ts` (created by GWP-134):
  - Server phase `help/write`:
    - read the `help/check` report;
    - `changes.length === 0` gives skipped with `no changed area is covered by a Help article`;
    - otherwise queue one `help_edits` task.
  - Finisher: the same as `guide/write`.
  - `PHASE_INPUTS['help/apply']` gives `{ proposal }` from the done task's `result`.
  - Shift title: `Update the Help articles (<branch>)`.
- `docs-prep-tasks.ts` `applyReleasePrepReport`: `help_edits` gets the schema parse only, because the file checks ran on
  the runner (same as `guide_edits`).

### 6.4 Web

- New `apps/web/src/components/delivery/HelpStepOutput.tsx`, modelled on `GuideStepOutput.tsx`:
  - "Updated: **<article title>** › <section heading>", one per item, with a link to `/help/<slug>#<id>`;
  - "Added: … (after …)";
  - "Skipped: no Help articles in this repository", or "No Help article needed changes" / "No new changes";
  - errors and warnings.
- `ReleaseDocsPrepTab.tsx`: `{s.step === 'help' && s.output != null && <HelpStepOutput output={s.output} />}`.
- No change to the settings panel or the queries: the step appears from the registry (finding 5).

### 6.5 Docs and Help text

- `apps/web/src/help/articles/phases.md {#release-prep}`:
  - Add **Update Help articles** to the list of steps.
  - Add one sentence: "**Update Help articles** brings the in-app Help sections for the changed features up to date
    after the user guide. It never renames or removes a section's link anchor or changes an article's header, it adds a
    new section only for a new feature, and the result lists the articles and sections it updated (or says none needed
    changes). A repository without Help articles shows the step as skipped."
  - Edit only the body; the heading line and `{#release-prep}` stay.
- `docs/USER-GUIDE.md`, release prep section: the same sentence. The heading line stays.
- `docs/RUNNER.md`, release prep workstation needs: Update Help articles needs the same writer agent as the guide.
- `docs/investigations/GWP-91-…md`: add a one-line pointer to the follow-up list: "Help articles: done in GWP-136 (step
  `help`)".

## 7. Risks

- **Dependency on GWP-134.** This design uses `writerPhase`, `PREP_TASK_KINDS`, `PREP_PROPOSAL_FILE`,
  `finishPrepProposal`, `docs-prep-writer.ts` and `stepInput` on every phase, all from GWP-134. The card is blocked on
  GWP-134 (dependency). If GWP-134 is dropped or redesigned, this design must be revisited. It must not fall back to
  the headless `runModel` call.
- **Parser drift.** The shared parser copies the app's heading rules. The parity test (section 8, Web 1) stops silent
  drift. Moving `slugify` into shared is a possible later tidy-up and is out of scope here.
- **Writer cost.** The step adds one writer shift per release that has Help-relevant changes. The relevance filter in
  `check` skips the writer when no change touches the web app and no Help section matches.
- **Group siblings.** GWP-161 adds a per-repository guide path setting. If it adds a settings object, `helpDir` can join
  it later; no conflict now. GWP-160 (PDF date) does not touch these files. Coordinate the one-line `STEPS` change in
  `docs-prep.ts`.
- **e2e.** `e2e/tests/release-docs-prep.spec.ts` may count steps or rows. The testers run it and update the count if
  needed.

## 8. Acceptance criteria mapping and tests

| AC | Where it is met | Test |
| --- | --- | --- |
| Architect's check of release/1.6.0 on the card | Section 2, plus the card comment | n/a |
| A changed feature's existing section is updated | `check` hints → `help_edits` task → `apply` with `applyHelpEdits` | Runner 1, Shared 1 |
| Unchanged articles and sections are byte-for-byte unchanged | Only the changed slugs are written. Sections are rebuilt from the original lines and only the named section bodies change. The heading self-check runs | Runner 1 (byte compare of the other fixture files), Shared 1 |
| Every anchor kept, none duplicated, new sections get a new unique id | `checkHelpUpdate` effective-id rule, explicit-id uniqueness, and the new-heading-needs-id rule | Shared 2, 3 |
| Links from the guide, pageHelp, HelpHint, tour and What's New still resolve | Follows from the anchor rule; the existing link tests cover the real files | Web 2, existing `help.test.tsx:82,115` |
| Frontmatter valid; Help centre lists every article; search finds updated sections | Frontmatter byte rule plus the parse check | Shared 4, Web 1, Web 2 |
| Removing or renaming an anchor, breaking frontmatter or writing outside the folder fails clearly and commits nothing | `apply` refuses before writing; `changedPaths` guard; `keepWork` on `ok:false` | Runner 2, 3, Shared 2, 4, 5 |
| New step shows in settings and can be switched, run, retried and skipped | `HELP_STEP` in the registry; the generic settings and run path | Shared 6, Server 1 |
| The result lists the updated articles and sections, or says none | Output `changed`/`added`/`nothing`; `HelpStepOutput` | Runner 1, 4, Web 3 |
| `phases.md {#release-prep}` describes it | 6.5 | Web 2 (anchor still resolves) |
| Existing release docs prep, guide and help tests still pass | No change to the guide code | Existing suites |

**Shared** (`packages/shared/test/release-help-articles.test.ts`):

1. `applyHelpEdits`:
   - `replace_text`, `append` and `add_section` on a two-article fixture change only the named section;
   - a second run of the same edits gives `unchanged` with duplicates;
   - `\r\n` files keep their line endings.
2. Anchors:
   - an edit whose text contains a heading or `{#` is refused;
   - an `after` text that makes the check see a heading removed or renamed (simulate it by passing a hand-made `after`
     to `checkHelpUpdate`) gives `the anchor x#y would be removed or renamed`;
   - a new heading whose slug equals an existing derived id, inserted before it, is refused (it would shift `id` to
     `id-2`).
3. Duplicate ids:
   - `add_section` with an id that is already used is refused;
   - an `after` with two equal explicit ids is refused.
4. Frontmatter:
   - a changed `---` block, or a missing `title`, gives the header errors.
5. Outside the folder:
   - an article slug like `../x` fails the schema;
   - an unknown slug gives `unknown article`;
   - a new slug in `after` gives the create error.
6. Registry and settings:
   - `help` sits between `guide` and `videos`;
   - `enabledReleaseDocsPrepSteps({steps:{help:false}})` leaves it out, and the default includes it;
   - `missingReleaseDocsPrepRequirement` says `Update Help articles needs Analyse changes` when analyse is off.
7. `locateHelpSections` ranks the section whose title matches the change first.
8. `helpOutputSources` returns every source from changed, added, covered and skipped.
9. GWP-134 registry: `writableFilesFor(help_edits)`, and the `help_edits` schema parse.

**Runner** (`apps/runner/test/release-docs-prep-help.test.ts`, fixture repo like `release-docs-prep-guide.test.ts`):

1. `check` → `apply`, with a fixture where one merge changes `apps/web/src/pages/Releases.tsx` and a valid proposal
   edits `phases.md#releases`:
   - only `phases.md` is in `files`;
   - every other article is byte-identical to the base commit;
   - every anchor is kept;
   - the output lists `{article:'phases', section:'releases'}`.
2. `apply` with a proposal that breaks an anchor or the frontmatter: `ok:false` with `the Help update was refused: …`,
   files on disk unchanged, and through `runReleaseDocsPrep` no work commit (the work ref is unchanged).
3. A handler stub or fixture where an extra file outside `helpDir` changes gives `ok:false`, outside-folder message.
4. A release whose changes touch only `apps/server/**`, with no matching hints: `check` reports `changes: []` and
   `apply` with no proposal gives `nothing:'no new changes'` and no commit.
5. No Help folder: `check` returns `state:'skipped'` with the note.
6. Phase `''` gives the "newer server" failure.
7. GWP-134 `finishPrepProposal` for `help_edits`:
   - a valid proposal is accepted;
   - an anchor-breaking one is refused with the findings.

**Server** (`apps/server/test/`, Postgres suites are for the testers if they need a database):

1. Settings round-trip: `help` is listed with label and description, can be saved off and on, and an unknown id is still
   refused.
2. `help/write`:
   - a check report with no changes gives skipped and no task;
   - a report with changes queues one `help_edits` task;
   - the accepted result is sent as `input.proposal` to `help/apply`.
3. `help/check` skipped skips `write` and `apply`, and no agent is looked up.
4. `helpCoveredSources` reads the `apply` rows of earlier passed runs only.

**Web** (`apps/web/src/test/help.test.tsx`):

1. Parity: for every real article, `parseHelpArticle(src).headings.map(h => h.id)` equals
   `buildArticle(slug, src).headings.map(h => h.id)`.
2. Fixture run on real content:
   - apply a `replace_text` and an `add_section` to `phases.md` with `applyHelpEdits`;
   - `buildArticle` on the result still has the original title, order and every original heading id, plus the new id;
   - `searchHelp(<replacement words>, [updated article])` returns the updated section's `phases#<id>`;
   - every link checked by the existing link test still resolves against the updated set.
3. `HelpStepOutput` renders the updated list, the "no Help article needed changes" text and the skipped text (in
   `release-docs-prep.test.tsx`, next to the guide output test).

**Left for testers:** the server DB suites, `e2e/tests/release-docs-prep.spec.ts`, and the manual step on a test
project: switch the step on, run prep, check the result list and the Help diff, and open the Help centre and page help
links on the changed page.
