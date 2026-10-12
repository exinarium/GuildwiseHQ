# Architect role, investigation and design step (#9) and more than one workflow per project (#10)

Status: design, 2026-10-12. Backlog items #9 and #10 (`docs/BACKLOG.md`). Keeps #13 (builder, sub-workflows, triggers) open.
Builds on #4 (reference repositories, `readDirs`) and #8 (main branch and working branch per repository).

## 1. Decision summary

| # | Decision | Rejected alternatives |
| --- | --- | --- |
| D1 | **Built-in `architect` role** (Opus, effort high, senior only). Reads, designs, writes documents, commits; never writes product code except while resolving a merge of the main branch. Push and merge only through runner-run `aom git ...` verbs. | Give it `git push` in the shell: it would need the forge token inside the sandbox. Reuse the BA: the BA has no worktree and is already overloaded. |
| D2 | **`code` v2** adds stage `investigate` ("Investigate & design") between `spec` and `build`, skipped per card through `when: designNeeded` (a new card column, default from a project setting). Not added to `code-bugfix`. | Always on: an Opus shift on every typo fix. A separate workflow "code with design": doubles every code project's choice and needs #10 first. |
| D3 | **Investigation-only** is a card column `investigation_only`. Its route is `investigate` -> `finalize` (BA records the result in the ledger and `PROJECT.md`, then merges the report commit) -> `done`. Implemented with a new **outcome guard** (`Outcome.when`), not a parallel set of stages. | A separate "investigation" workflow: same stages, more catalogue, and the card could not switch to building. A new BA "write-up" stage: finalize already is the BA's last stage and already merges a branch. |
| D4 | **Merge latest main first** (project setting, on by default, per-card override): the **runner** merges `origin/<main>` into the **working branch** and pushes it, before the card's worktree is created; the card branch is then cut from the fresh working branch. On a conflict (or a protected/raced working branch) the runner instead merges main into the **card branch** in the card's worktree and leaves the conflict for the architect, whose resolution reaches the working branch through the card's normal completion. | Merge main into every card branch always: N cards make N copies of the same merge and may resolve the same conflict differently. Agent-run merge into the working branch: needs credentials and write access outside the worktree. |
| D5 | **Architect read access** = every repository of the organization on this workstation, named by remote by the server and resolved to the runner's own clones (the #4 mechanism, new `ReadRepo.kind: 'org'`), plus, when the workstation owner sets one, every git repository under an **organization source folder** configured on the runner (never sent by the server). Read-only, secret files denied. | Open all of `repoRoots`: #4 explicitly refused it (other organizations, `.env`, the platform's own code). |
| D6 | **#10: `project_workflows`** (a project enables a set; one is primary = today's `projects.workflow_key`; each enabled workflow names the card types it is the default for). A card picks a workflow at creation (explicit, else default by type). | An array column on `projects`: no room for per-workflow defaults; harder to project. |
| D7 | **#10: project variants** are ordinary `workflow_versions` rows with `project_id` set and `definition.extends = {key, version}`, authored as **insertions** (a stage inserted after an existing stage) and stored materialised (cards pin the full definition, the dispatcher needs nothing new). Base stages are immutable in a variant. Versioned and approved like custom workflows; running cards keep their version. | Mutable overlays resolved at claim time: a card's route could change mid-flight. Full free-form copies of built-ins: every built-in rule (events, effects, data) would have to be re-validated for arbitrary edits. |
| D8 | **Stage matching by prefix**: `claimableStages[].stageId` may end in `*` (`investigate*`). The architect claims `('*', 'investigate*')`, so an investigation stage can be inserted after any stage, in a variant or a custom workflow, with ids `investigate`, `investigate_after_test`, ... | A `template` field on stages: one more concept to validate; the id convention is already how roles match stages. |

## 2. The architect role (#9)

### 2.1 Definition (`packages/shared/src/roles/builtin.ts`)

```ts
role({
  key: 'architect', version: 1, name: 'Architect',
  purpose: 'Investigates and designs cards before they are built: reads the code (any repository of the organization), compares, writes the design or investigation report, merges the main branch.',
  department: 'delivery',
  instructions: ARCHITECT_INSTRUCTIONS, coreRules: ARCHITECT_CORE_RULES,
  seniorityLevels: ['senior'],
  defaultModel: { runtime: 'claude-code', model: 'opus', effort: 'high' },
  permissions: perms({
    allowedTools: ['read', 'edit', 'shell', 'web'],
    // push stays denied (the runner pushes); merge/commit/add allowed; checkout/switch/rebase/reset denied
    deniedShellPatterns: [...COMMON_DENIED_SHELL, 'git fetch*', 'git pull*', 'git remote*'],
    writableGlobs: ['docs/**', '**/*.md'],   // the runner adds the project's investigation path (2.4)
    mayCommit: true,
    readOrgRepos: true,                      // new permission flag, 2.3
  }),
  skills: [],
  claimableStages: [{ workflowKey: '*', stageId: 'investigate*' }],
}),
```

`AgentPermissionsSchema` gains `readOrgRepos: z.boolean().default(false)` (custom roles may set it; the owner approves the role, so this is an explicit grant). Validation of custom roles: warn when `readOrgRepos` is set (shown on the approval).

**Instructions outline** (`ARCHITECT_INSTRUCTIONS`):
1. Read the whole card, the handoffs, `PROJECT.md`, the ledger (`aom ledger search`).
2. If the brief says a main-branch merge is waiting in your worktree (2.5), resolve it first: fix the conflicted files, `git add`, `git commit --no-edit`, then `aom git verify-merge`. Never change behaviour while resolving.
3. Investigate: the card's repository (your worktree), the other readable repositories listed under "Readable folders" (comparisons), the web for best practice. Run code read-only or in a copy under your scratch dir (like the reviewer).
4. Write the result to the report path given in the brief (default `docs/investigations/<REF>-<slug>.md`): question, findings, comparison, options, recommendation; for a build card also the **design**: files/modules to change, data model, API, risks, and how the acceptance criteria map to the design. Commit it on the card branch.
5. Build card: `aom design --report <path> --summary "<3-6 lines for the builder>"` (outcome `handoff`, to build). Investigation-only card: `aom investigate --report <path> --summary "..."` (outcome `report`, to finalize).
6. Anything only the owner can decide: `aom question` (blocking) with options and a recommendation.
7. `aom git push` publishes the card branch when the report should be visible before the card ends (optional).

**Core rules**: never change product code or tests except to resolve a main-branch merge conflict; never push, rebase, reset or switch branches yourself (the runner does); write only under the documentation paths of your worktree; other repositories are read-only; never copy secrets or credentials into a report.

### 2.2 Model and hiring

Default Opus/high. The setup checklist and the workability check (`queries/workability.ts`) report "no architect hired" for a card queued in an `investigate*` stage of an org with no active architect (same pattern as the existing missing-role reasons). The Hire form lists the role like the others.

### 2.3 Read access: every repository of the organization

Two sources, both read-only, both through the existing #4 machinery (`readDirs` -> `--add-dir`, sandbox `allowRead` per entry via `sandboxReadEntries`, `denyWrite`, `secretReadDenies`):

1. **Registered repositories (always).** Server: new `orgReadRepos(db, orgId, userId)` in `apps/server/src/runner-gateway/read-repos.ts`: every non-removed `project_repos` row of an active project of the organization (excluding `kind = 'interest'`) of which the workstation owner is an active member. `ReadRepoSchema.kind` gains `'org'`. `brief.ts` sends `readRepos = project ∪ reference ∪ org` when the agent's effective role has `readOrgRepos`. The runner resolves by remote to its own clones (`resolveReadRepos`, unchanged rules: never the home dir, the runner dir, `HOME_SECRETS`).
2. **Organization source folder (optional, runner-local).** Runner `config.json`: `orgSourceFolders: { [orgId]: string }` set with `aom-runner org-folder set <org> <path>` or the Workstations page (the page sends the path to the runner as a command; the server stores only a "set" flag, never the path, mirroring #4's "by remote, never by path"). The folder must be inside one of `repoRoots`, must not be or contain the home dir, the runner data dir or a `HOME_SECRETS` path. The runner scans it with `scanRepos` (existing, depth 3) and opens each git repository found as a read-only folder (`kind: 'org'`, name = folder name). Only for shifts and chats of agents with `readOrgRepos` and only for that org.

Instructions render the list under the existing "Readable folders" section (`renderReadableFolders`).

### 2.4 Writes, commit, push, merge

- **Where it writes**: only its card worktree, only `writableGlobs` + the project's investigation path (`projects.investigation_path`, default `docs/investigations`, resolved by the runner like the tester's e2e globs). Enforced by the post-shift guard (`shifts/guard.ts`, `architect_edited_non_docs`), with one exception: paths changed by a merge commit whose second parent is the `origin/<main>` SHA the runner recorded in the shift's prepare step (2.5) are allowed (conflict resolution).
- **Commit**: `mayCommit: true`; leftovers auto-committed as today.
- **Push** (`aom git push`): new IPC rpc `git.push`; the runner pushes **the card branch only** (`git push -u origin <branch>` with `GitAuth`, the same code path as `push_branch` completion). Any other ref is refused. Allowed only in shifts whose stage id matches `investigate*` (the runner knows the stage from the brief).
- **Merge**: the architect never merges into the working or main branch itself. Main -> working happens in the runner's prepare step (2.5); card -> working happens in finalize (existing completion code). `aom git merge-main` (rpc `git.merge_main`) lets the architect re-run the card-branch merge of the latest main during its shift (runner fetches, then `git merge --no-ff origin/<main>` in the worktree, leaving conflicts in place).
- `aom git fetch` (rpc `git.fetch`): the runner fetches `origin` in the clone (worktrees share refs) so the architect can compare `origin/<main>` and `origin/<working>`.

### 2.5 Merge latest main first

Settings: `projects.merge_main_first boolean NOT NULL DEFAULT true`; card override `cards.merge_main_first boolean NULL` (null = project). Stage flag `StageSchema.syncMainBefore: boolean` (default false; true on `code.investigate` and `code.build`): the step runs on the **first worktree creation** of a card at a stage with the flag, i.e. at investigate, or at build when investigate is skipped. Never on reuse, never for bug children, never when the repository's main branch equals its working branch (then cutting the card branch from `origin/<working>` already is "latest main").

`ShiftStart.prepare` gains `syncMain?: { mainBranch: string; workingBranch: string }`. Runner, before `ensureWorktree(create)` (`apps/runner/src/git/sync-main.ts`, new):

1. Per-repository lock (the runner serialises sync and completion on one clone).
2. `fetch origin <main> <working>`. If `origin/<main>` is already an ancestor of `origin/<working>`: nothing to do.
3. Integration worktree (same helper the `merge` completion uses) on `origin/<working>`; `git merge --no-ff -m "Merge <main> into <working> (aom <REF>)" origin/<main>`.
4. Clean: push `<working>` (fast-forward of origin). Rejected because the branch moved: refetch and retry once. Rejected because protected (forge `rules`) or retry failed: go to 5. Success: `ensureWorktree(create)` cuts the card branch from the new `origin/<working>`. Report `syncMain: {result: 'merged_into_working', commit}` in `shift.started`.
5. Conflict or not pushable: abort, clean up the integration worktree, create the card worktree normally, then `git merge --no-ff origin/<main>` **inside the card worktree**. Clean: commit, report `merged_into_card`. Conflict: leave it in progress, report `conflict_in_card {files}`; the brief tells the architect (2.1 step 2). If the stage holder is not an architect (investigate skipped, build creates the worktree): abort the merge, report `skipped_conflict {files}`, the server posts a card notice and a desk notice ("main could not be merged into <working>: <files>"); the build goes ahead on the working branch.

Server: `CardMainSynced {cardId, repoId, result, commit?, files?}` (card stream, audience project) from `shift.started`; projection writes nothing beyond a card thread note. `prepare.syncMain` is computed in `claim.ts` next to `rebase` (stage flag, card/project setting, `repo.main_branch` set and different from the working branch, `created === true`).

"The BA always gives the instruction": the BA does not have to. The project setting is the instruction; the BA brief mentions it, and the BA sets the card override (`mergeMainFirst: false`) only for a reason (e.g. a hotfix on the working branch).

## 3. The investigate stage and investigation-only cards (#9)

### 3.1 New card columns and project settings (migration `1640_architect.sql`)

```sql
ALTER TABLE cards    ADD COLUMN design_needed boolean NOT NULL DEFAULT false,
                     ADD COLUMN investigation_only boolean NOT NULL DEFAULT false,
                     ADD COLUMN merge_main_first boolean;
ALTER TABLE projects ADD COLUMN design_step boolean NOT NULL DEFAULT false,      -- see Q1 (true for new projects)
                     ADD COLUMN merge_main_first boolean NOT NULL DEFAULT true,
                     ADD COLUMN investigation_path text NOT NULL DEFAULT 'docs/investigations',
                     ADD COLUMN investigation_location text NOT NULL DEFAULT 'repo' CHECK (investigation_location IN ('repo','vault'));
```

`CARD_COLUMN_FIELDS` gains `designNeeded` and `investigationOnly` (boolean) so `when` and outcome guards can use them. Code field set gains `reportPath?: string` (card override of the report location, validated: relative, no `..`, inside the worktree or `vault:<path>`). `CardCreated`/`CardUpdated` carry `designNeeded`, `investigationOnly`, `mergeMainFirst`. Create: `designNeeded` defaults to `project.design_step`; `investigationOnly: true` forces `designNeeded: true` (400 `investigation_needs_design` if the client sends false). Project settings change with a new `ProjectArchitectSettingsSet {projectId, designStep, mergeMainFirst, investigationPath, investigationLocation}`.

### 3.2 Schema additions (`packages/shared/src/workflows/schema.ts`)

- `OutcomeSchema.when?: {field, equals}`: the outcome is offered and accepted only when the card's boolean field equals the value. `resolveOutcome` refuses a guarded outcome that does not apply (`WorkflowResolveError 'outcome_not_allowed'`); the brief lists only the allowed outcomes. Validation: rule 9 also covers outcome guards; rule 2 becomes "every non-terminal stage has, for each value of each guard field it uses, at least one allowed success outcome" (with one guard field per stage this is: an unguarded success outcome, or success outcomes for both `true` and `false`).
- `StageSchema.syncMainBefore: boolean` (2.5).
- `OutcomeDataKindSchema` gains `'investigation'`: `{reportPath: string, summary: string (<= 2000), location: 'repo'|'vault', commit?: string}`; the runner fills `commit` (HEAD) and checks that a `repo` report exists and is committed.

### 3.3 `code` v2 (`packages/shared/src/workflows/builtin/code.ts`, keep v1)

```
spec (manual)        specified -> investigate (CardSpecified)            [investigate skipped when designNeeded=false -> build]
investigate          agent / architect, seniorOnly, worktree create, syncMainBefore, maxShiftMinutes 90,
                     when {designNeeded: true}, requiredFields: title, cardType, context, requirements, repoId
                     handoff -> build     (StageCompleted, data investigation, when {investigationOnly: false})
                     report  -> finalize  (StageCompleted, data investigation, when {investigationOnly: true})
build                unchanged (worktree create = create or reuse; the path decides), + syncMainBefore
review/test/docs     unchanged
finalize             unchanged stage; the BA's brief branches on investigationOnly (3.5)
done
```

"Needs owner input" is not an outcome: the architect raises a blocking `aom question` (existing: card -> Blocked, back to investigate when answered). Sending a card back to the BA for re-spec also uses a question (`--doing "spec unclear"`), which the BA answers or escalates.

Server changes:
- `specifyTarget` (`commands/cards.ts`) must use `resolveOutcome` so a `when`-skipped target is skipped (today it uses `o.to` raw).
- **Required fields at specify**: new shared `requiredForSpecify(def, card)` = the requiredFields of the entered stage plus those of every stage on the card's success path (allowed success outcomes, `when` skips honoured) until a terminal. A build card therefore still needs the full build field set at specify (BA behaviour unchanged); an investigation-only card needs only title, type, context, requirements, repo. Used by `specify`, intake and the UI's "missing" list.
- Outcome transitions into a stage now also check `requiredMissing` (defensive; refuses the report with the missing list).
- Dependency gate (`dispatcher/candidates.ts`): today `c.stage = 'build' AND c.rework_round = 0`; becomes `((c.stage = 'build' AND c.rework_round = 0) OR (c.repo_id IS NOT NULL AND c.worktree_path IS NULL))`, so the investigate shift (which now creates the branch) also waits for dependencies; otherwise the card branch would be cut before its dependencies land.
- `InvestigationReported {cardId, reportPath, location, summary, commit?}` appended with the outcome (follow-up event; #13 triggers can listen to it). Card detail shows the report (repo: link to the file on the card branch / forge; vault: vault path).
- `vault` location: the runner reads the report file from the worktree (or scratch) and the server queues `vault.write` to `<project vault folder>/<investigation_path>/<REF>-<slug>.md` (path validated); nothing is committed in the repo.

### 3.4 Report location, in order of precedence

card `fields.reportPath` > project `investigation_path` + `investigation_location` > `docs/investigations` in the card's repository. File name `<REF>-<slug(title)>.md` when the path is a folder. Rendered into the architect's brief ("Write your report to ...").

### 3.5 BA: investigation-only finalize (BA v10)

Finalize brief for `investigationOnly` cards (BA instructions, new subsection "Investigation-only cards"):
1. Read the report (path in the latest handoff data).
2. `aom investigation record --title "<what was investigated>" --summary-file <md> [--decision]`: server appends `LedgerEntryAdded` (scope `feature`, or `decision` with `--decision`; `cardId`, `projectId`, tags `investigation`, body = summary + report link) and queues the `PROJECT.md` managed section `investigations` (`vault.write mode 'section'`, like `writeResearchIndex`: a list of `REF title -> report path, date`, rebuilt from `InvestigationReported` + ledger rows, versioned by event seq). Non-terminal; refused unless the card is investigation-only and in finalize.
3. `aom finalize --action merge` (repo location: the report commit lands on the working branch through the existing completion code; the server refuses `pr`/`push_branch` only if the project says so; vault location: `--action none`, new value allowed only for investigation-only cards, no git).
The server refuses `finalized` on an investigation-only card until step 2 happened (`ledger_entries` row with the card id and tag `investigation`).

BA intake instructions also gain: when to set `designNeeded` (default from the project; switch off for trivial, well-located changes), when to create an investigation-only card (comparisons, "how should we", spikes), `reportPath` when the manager names a place.

## 4. More than one workflow per project; variants (#10)

### 4.1 Data model (migration `1650_project_workflows.sql`)

```sql
CREATE TABLE project_workflows (
  project_id          uuid NOT NULL REFERENCES projects(id),
  workflow_key        text NOT NULL,
  is_primary          boolean NOT NULL DEFAULT false,      -- exactly one per project = projects.workflow_key
  default_card_types  text[] NOT NULL DEFAULT '{}',        -- card types this workflow is the default for
  enabled_at          timestamptz NOT NULL,
  PRIMARY KEY (project_id, workflow_key)
);
CREATE UNIQUE INDEX project_workflows_one_primary ON project_workflows(project_id) WHERE is_primary;
INSERT INTO project_workflows SELECT id, workflow_key, true, '{}', created_at FROM projects;   -- migration path
ALTER TABLE workflow_versions ADD COLUMN project_id uuid REFERENCES projects(id),   -- non-null: a project variant
                              ADD COLUMN base_key text, ADD COLUMN base_version integer;
```

A card type's default is resolved as: an enabled workflow whose `default_card_types` contains it; else the primary if it lists the type; else any enabled workflow listing it (first by `enabled_at`); else `CROSS_PROJECT_CARD_TYPES`. Two enabled workflows may not both claim the same type as default (400 `duplicate_default`). `projects.workflow_key` stays the primary (convert, research stage, regression, hygiene, phases keep working). `ProjectConverted` also updates the primary row.

`WorkflowDefinitionSchema` gains `extends?: {key: string, version: number}`. Variant keys: `<base>-<projectkey lowercase>` suggested, any valid custom key allowed; unique per organization.

### 4.2 Variant authoring and materialisation (`packages/shared/src/workflows/variant.ts`, new)

```ts
export const StageInsertionSchema = z.object({
  after: z.string(),                 // an existing stage id (base or earlier insertion), not terminal
  stage: StageSchema.omit({ outcomes: true }).extend({
    outcomes: z.array(OutcomeSchema).optional(),   // default: one success outcome `done` -> the successor
  }),
  /** Which outcomes of `after` are redirected to the new stage; default: all its success outcomes. */
  redirect: z.array(z.string()).optional(),
});
export const WorkflowVariantSpecSchema = z.object({
  key: z.string(), name: z.string(), projectId: z.uuid(),
  base: z.object({ key: z.string(), version: z.number().int() }),
  insertions: z.array(StageInsertionSchema).min(1).max(8),
});
export function materialiseVariant(base: WorkflowDefinition, spec: WorkflowVariantSpec): WorkflowDefinition
```

Materialising: copy the base; for each insertion, for each redirected outcome `o` of `after`, the new stage's default success outcome targets `o.to` and `o.to` becomes the new stage. Special base events stay on the base stage (e.g. `test.pass` keeps `TestPassed` but now targets `investigate_after_test`). The new stage's `column` is its label; `builtIn: false`, `extends: base`. Both the spec (`workflow_versions.variant_spec jsonb`) and the materialised definition are stored; the definition is what cards pin and what `workflow_stages` flattens. Columns of inserted stages appear on the board in stage order.

**Validation** (`validateVariant(spec, base, roles)`): all nine rules on the materialised definition, plus:
- base stages unchanged except redirected outcome targets (diff check against the base);
- `fieldSet` and `cardTypes` from the base (cardTypes may be narrowed, never widened);
- inserted stages: `kind: 'agent'`, outcomes `StageCompleted` only, effects none, data `none` (or `investigation` when the claim role has a stage pattern `investigate*`), `worktree` `reuse` (or `create` when inserted before the first worktree stage), `requiredFields` from the field set;
- rule 3 with lineage: an inherited stage is claimable when the role claims `(def.key, id)` **or** `(def.extends.key, id)`; an inserted stage needs a role claiming `(def.key, id)`, `('*', pattern)` (architect) or a custom role naming the variant key;
- `code-bugfix`, `feed` and `research` cannot be bases (internal / special); allowed bases: `code` and approved custom workflows.

`roleClaimsStage` supports a trailing `*` in `stageId` (prefix match). Built-in roles' `claimableStages` otherwise unchanged; lineage is applied by the validator and by nothing else (the dispatcher routes by `workflow_stages.claim_role`).

**"Investigation after any work"**: the variant editor offers a template "Investigate & design" (architect, id `investigate_<after>`, `syncMainBefore` optional, outcome `done` with data `investigation`) insertable after any agent stage; e.g. after `test` for a "compare with best practice / check against main" step before docs.

**Versioning**: saving creates a draft; submit/approve reuse the M10 flow (`WorkflowVersionRegistered` with `projectId`, `variantSpec`; desk approval; `...Approved` supersedes the previous variant version). Cards pin `workflow_version_id`; approving v2 affects only new cards. A newer base version (e.g. `code` v3) does not move a variant: the settings show "based on code v2, v3 available", and **Rebase** re-materialises the same insertions on the new base as a new draft version (insertions whose `after` no longer exists are reported as validation errors).

### 4.3 Server

- `resolveCardWorkflow(db, project, cardType, workflowKey?)`: explicit key must be enabled on the project (or a cross-project type), else 400 `workflow_not_enabled`; without a key, the default resolution of 4.1. `resolveWorkflow` gains the project: a project variant resolves only for its own project.
- Card create (REST `POST /api/cards`, `aom card create` draft, schedules' card templates, intake) accepts `workflowKey`.
- `GET /api/board`: columns = `boardColumnsWith(primary, enabled others ∪ others with open cards)`; enabled workflows' columns always shown.
- Routes (`routes/projects.ts`, `commands/project-workflows.ts` new):
  - `GET /api/projects/:id/workflows` -> `{enabled: [{workflowKey, name, version, isPrimary, defaultCardTypes, variantOf?, pendingVersion?}], available: [...]}`
  - `PUT /api/projects/:id/workflows` `{enabled: [{workflowKey, defaultCardTypes}]}` -> `ProjectWorkflowsSet {projectId, enabled[], by}` (full set; primary always included and not removable here; disabling a workflow with open cards is allowed, the cards finish on their pinned version).
  - `POST /api/projects/:id/workflow-variants` (spec) -> draft, issues; `PUT .../:versionId`; `POST .../:versionId/submit`; `POST .../:versionId/rebase`.
  - Authorization: Owner and Admins of the project's organization (same predicate as convert, `canConvertProject`); see Q5.
- BA designer chat: `aom org workflow variant --file <spec.json>` (rpc `org.workflowVariant`), same validation reply.
- Workflow-key literals: `ConvertProjectDialog` filters and `CardNew` research filter keep working; grep-level audit of `'code'` literals in server/web is part of WP-A.

### 4.4 Web

- **Project settings -> Workflows** (`apps/web/src/pages/ProjectSettings.tsx`, new `components/ProjectWorkflows.tsx`): enabled list (primary marked), "Default for" card-type chips, enable/disable, "Customise" (opens the variant editor on the current workflow), pending approval badge, "Rebase on vN".
- **Variant editor** (`components/WorkflowVariantEditor.tsx`): the base stages as a read-only vertical list with "+ insert step after" between them; the inserted step form: template (Investigate & design / custom), label, role (roles that may claim it), done criteria, required fields, worktree; live validation issues from the draft endpoint. This list-with-inserts is the seed of #13's visual builder.
- **Project settings -> Architect** section: Investigate & design before build (design_step), Merge latest main first, Investigation report location (repo path / vault path).
- **Card create / edit** (`CardNew.tsx`, card edit form): workflow picker when more than one enabled workflow lists the chosen type (defaulted); checkboxes Investigate & design, Investigation only (implies the first), Merge latest main first (tri-state: project default / on / off), Report path (advanced).
- **Card detail**: investigation report panel (summary, path/link, commit), main-sync note.
- Board: workflow chip on cards whose workflow is not the primary (exists for cross-project cards).

## 5. Keeping #13 open

- Variants are insertions over a base; #13's builder can author full definitions on the same `workflow_versions` rows (`extends` absent) and reuse the insert UI.
- Outcome guards (`Outcome.when`) and the prefix stage matching are generic, not architect-specific.
- `InvestigationReported`, `CardMainSynced`, `ProjectWorkflowsSet` are ordinary events: #13 event triggers can subscribe.
- Sub-workflows (#13) will need an outcome effect `spawn_child {workflowKey}`; `project_workflows` already tells which workflows a project may start. Nothing here assumes one workflow per card lineage.

## 6. Work packages

Order: **WP0 -> (WP1 ∥ WP3) -> (WP2 ∥ WP4 ∥ WP5)**. WP1/WP2 are #10, WP3-WP5 are #9; they share only WP0.

### WP0 Shared foundation (small, first; one builder, ~0.5 day)
- `packages/shared/src/workflows/schema.ts`: `Outcome.when`, `Stage.syncMainBefore`, `extends`, data kind `investigation`.
- `packages/shared/src/workflows/resolve.ts`: guard handling, `allowedOutcomes(def, card, stageId)`.
- `packages/shared/src/workflows/validate.ts`: rule 2/9 for guards.
- `packages/shared/src/roles/schema.ts`: prefix `*` in `roleClaimsStage`; `readOrgRepos` permission.
- `packages/shared/src/cards/fields.ts`: `designNeeded`, `investigationOnly` column fields, `reportPath`, `requiredForSpecify`.
- `packages/shared/src/protocol/ipc.ts`: `InvestigationData`.
- Tests: `resolve.test.ts` (guarded outcomes, skip + guard), `validate.test.ts` (guards), roles schema (prefix), fields (`requiredForSpecify`).

### WP1 #10 server: project workflows and variants
- `apps/server/migrations/1650_project_workflows.sql`; `packages/shared/src/events/project.ts` (`ProjectWorkflowsSet`), `events/catalogue.ts` (`projectId`, `variantSpec` on `WorkflowVersionRegistered`/`WorkflowDraftUpdated`); projections `projects.ts`, catalogue projection.
- `packages/shared/src/workflows/variant.ts` (+ `custom.ts` lineage-aware rule 3), `packages/shared/src/api/projects.ts` DTOs.
- `apps/server/src/catalogue/loader.ts` (`resolveWorkflow` with project), `commands/cards.ts` (`resolveCardWorkflow` with key), `commands/schedule-actions.ts`, `commands/schedules.ts`, `commands/intake.ts`, `commands/designer.ts` + `design-rpc.ts` (variants), new `commands/project-workflows.ts`, `routes/projects.ts`, `queries/cards.ts` (board columns), `commands/convert.ts` (primary row).
- Runner CLI: `apps/runner/src/aom/aom-cli.ts` `org workflow variant`.
- Tests: variant materialise/validate units (insert after build, after test with `TestPassed` redirect, refuse base edits, lineage rule 3); server integration: enable two workflows, default by type, explicit key, disabled workflow refused, variant approve -> new cards pin v1 then v2 while v1 cards finish on v1; migration test (each project gets one primary row); dispatcher test: a card in an inserted stage is claimed by the named role.

### WP2 #10 web
- `ProjectSettings.tsx`, new `ProjectWorkflows.tsx`, `WorkflowVariantEditor.tsx`, `CardNew.tsx`, `Board.tsx` chip, API client.
- Tests: component tests for the editor (insert, issues shown), card-create picker defaulting; e2e (mock runtime) one card through a variant with an inserted custom stage.

### WP3 #9 server and shared: architect, code v2, investigation-only
- `roles/builtin.ts`: architect v1, BA v10 instructions (intake flags, finalize investigation-only), builder v3 instruction line "read the design report in the handoff first".
- `workflows/builtin/code.ts` (v2) + `builtin/index.ts`.
- `apps/server/migrations/1640_architect.sql`; events `card.ts` (`CardCreated/Updated` fields, `InvestigationReported`, `CardMainSynced`), `project.ts` (`ProjectArchitectSettingsSet`); projections.
- `commands/cards.ts` (`specifyTarget` via `resolveOutcome`, `requiredForSpecify`, flag rules), `commands/shifts.ts` (investigation data, guard refusal, requiredFields on transition, `InvestigationReported`), `commands/finalize.ts`/`ba-finalize.ts` (investigation-only: `record` required, action `none` for vault), new `commands/investigation.ts` (`aom investigation record` rpc -> ledger + PROJECT.md section, reuse `writeResearchIndex` pattern), `dispatcher/candidates.ts` (dependency gate), `dispatcher/claim.ts` (`prepare.syncMain`), `runner-gateway/brief.ts` (report path, readRepos org, allowed outcomes), `runner-gateway/read-repos.ts` (`orgReadRepos`), `queries/workability.ts` (no architect).
- `packages/shared/src/protocol/runner.ts`: `ReadRepo.kind 'org'`, `prepare.syncMain`, `shift.started.syncMain`.
- Tests: specify of a build card still needs the full field set; investigation-only card specify needs the short set; architect `handoff` refused on an investigation-only card and `report` on a build card; `designNeeded=false` skips investigate on specify; finalize refused before `investigation record`; ledger + vault.write queued; dependency gate on investigate; claim computes `syncMain` only on create with main != working; brief contains org read repos only for `readOrgRepos` roles.

### WP4 #9 runner
- `apps/runner/src/git/sync-main.ts` (new; per-repo lock shared with `completion.ts`), `shifts/supervisor.ts` (prepare step, brief note), `git/completion.ts` (reuse integration-worktree helper), `aom/aom-cli.ts` (`design`, `investigate`, `investigation record`, `git push|fetch|merge-main|verify-merge`), IPC handlers (`git.*` rpcs: card branch only, stage `investigate*` only), `shifts/guard.ts` (architect globs + merge exception, report file committed), `read-repos.ts` + `config.ts` + `cli.ts` (`orgSourceFolders`, `org-folder set|clear`), `adapters/claude-policy.ts` (no change expected; verify `readDirs` covers org folders), `adapters/mock-agent.ts` (architect mock actions: `design`, `investigate`, `conflict`).
- Tests (real git fixtures, like `completion.test.ts`): sync clean -> working pushed, card cut from it; working moved -> retry; protected -> falls back to card merge; conflict -> left in card worktree for architect, aborted for builder; main == working -> no-op; guard allows merge-commit paths only from the recorded main SHA; `git.push` refuses any ref but the card branch; org source folder refuses home/runner dir/secrets and opens only git repos under it; policy test: org folders read-only, `.env` denied.

### WP5 #9 web and docs
- `ProjectSettings.tsx` Architect section, `CardNew.tsx`/card edit flags, `CardDetail.tsx` report panel + sync note, `Workstations.tsx` organization source folder, setup checklist item "hire an architect".
- Docs: `docs/ARCHITECTURE.md` 6.1/6.2/6.6/7/9.3/13.5-13.7, `docs/SPEC.md`, `docs/USER-GUIDE.md` (architect, investigation-only, merge main first, workflows and variants), `docs/RUNNER.md` (org source folder, threat model).
- E2E (mock runtime): feature card spec -> investigate (architect) -> build ... -> done with report link; investigation-only card -> finalize with ledger entry and PROJECT.md section.

## 7. Risks

- **Cost and latency**: an Opus shift per card. Mitigated by `designNeeded` (BA turns it off for trivial cards) and the project setting.
- **Stalled cards in orgs without an architect** once `code` v2 is live: new cards would wait in investigate. Mitigation: `design_step` off for existing projects (Q1), workability reason, setup checklist.
- **Pushing the working branch outside finalize** (sync step) is new behaviour: other cards' worktrees see a moved working branch; they already rebase before test/finalize. Branch protection is respected (fallback to card merge).
- **Broader read access** (all org repos) widens what a prompt-injected architect can read; still read-only, secrets denied, org-scoped, owner-granted folder. Reports are committed to repos: the guard should scan the report for obvious secrets (reuse `leak-check`).
- **Dependency gate change** delays investigation of dependent cards until their dependencies are done.
- **Variants and hard-coded stage ids** (`'build'`, `'finalize'`, `'test'`): safe because base stage ids are immutable in a variant; inserted stage ids must not collide with them (validator).
- **specifyTarget bug fix** changes behaviour for any custom workflow whose specify target has a `when` (today ignored).

## 8. Owner questions (with recommendation)

- **Q1 Design step default.** On for new projects; for existing projects on or off? *Recommend:* on for new projects, off for existing ones with a one-time desk notice "turn on Investigate & design" (avoids stalls in orgs without an architect).
- **Q2 Which main merge.** main -> working branch by the runner, falling back to the card branch on conflict (D4)? Or always into the card branch? *Recommend:* D4.
- **Q3 Organization source folder.** Registered repositories of the org always, plus an optional runner-local folder per org (D5)? Or registered repositories only? *Recommend:* D5; the folder is opt-in per workstation.
- **Q4 Report location default.** `docs/investigations/` in the card's repository (merged to the working branch at finalize), with vault as the alternative? *Recommend:* yes.
- **Q5 Who may enable workflows and create variants.** Org Owner and Admins only, with desk approval of variants by the owner? *Recommend:* yes (same as convert and the designer).
- **Q6 Architect in code-bugfix.** Not added (bug children are small fixes on the parent's branch). *Recommend:* not added.
- **Q7 Dependencies gate investigation.** Investigation of a card waits for its dependencies (because the branch is cut then)? *Recommend:* yes; a "design ahead" option can come later (investigate without a worktree).

## Owner decisions (2026-10-12)

1. **Design step default:** **off by default** everywhere (new and existing projects); a project opts in with the
   project setting, and each card can still override. No desk notice needed; the setting is explained in project settings.
2. **Merge latest main first:** into the **working branch** (runner merges and pushes), falling back to the **card branch**
   on conflict or a protected working branch; the architect resolves conflicts.
3. **Architect read access:** all repositories of the organisation's projects **plus** every git repository under an
   **organisation source folder** set on the runner. Read-only, secret files blocked.
4. **Who edits workflows:** organisation Owners and Admins enable workflows and create project variants; a variant needs
   the owner's approval on the desk before cards use it.
5. Accepted recommendations: report default `docs/investigations/` in the repository with the vault as alternative; the
   architect is not added to `code-bugfix`; dependencies also hold back the investigate stage.
