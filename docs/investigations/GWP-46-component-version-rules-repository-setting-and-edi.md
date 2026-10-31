# Component version rules: repository setting, editor and shared helper

This is part 1 of 4 of "Ship release". It stores the rules, validates them, shows an editor and provides a helper.
Release behaviour does not change in this part.

## Questions

1. Where are the per-repository component version rules stored, how are they changed, and how are they returned?
2. How are they validated, so that a bad rule is refused with a message that names the problem?
3. How does the GuildwiseHQ repository get the runner rule without the rule being hard-coded anywhere else?
4. Which shared helper do parts 2 (desk item, server) and 3 (release commit, runner) use to decide whether a rule
   applies, read the current version and replace it? Its signature is fixed here.
5. What does the expert-mode editor look like?

## Findings

- **Repository settings** are columns on `project_repos`. Each setting has its own event, one projector line and one
  field on the `PATCH /api/projects/:id/repos/:repoId` body. Example: the `ProjectRepoMainBranchSet` event is appended
  by `setRepoMainBranch` (`apps/server/src/commands/forges.ts:182`) and projected at
  `apps/server/src/projections/projects.ts:444`. Its body field is in `PatchRepoRequestSchema`
  (`packages/shared/src/api/projects.ts:523`) and its route is at `apps/server/src/routes/projects.ts:458`. The DTO is
  built in `apps/server/src/queries/misc.ts:283-300` from `SELECT * FROM project_repos`, so a new column is already
  read there.
- **Who may change settings**: only the owner (`loadVisibleProject`, then `p.my_role !== 'owner'` → `forbidden`).
  Expert mode is a per-user display preference (`useExpertMode()`, `apps/web/src/lib/expert-mode.ts`). It hides UI and
  does not authorise anything, so the server does not check it.
- **Errors**: if the body schema fails, the client gets `400 validation_error`, message "request validation failed".
  That message does not name the problem. If a command throws `badRequest(code, message, details)`
  (`apps/server/src/errors.ts:13`), the client gets that message, and the web `ErrorBox` shows `error.message`. So the
  semantic checks belong in the command, not in the zod body schema.
- **Data migrations** (`apps/server/src/data-migrations/index.ts`) run once at boot, in list order. Each one is
  recorded in `data_migrations`, is idempotent and appends events as `SYSTEM_ACTOR` (pattern: `ceo-working-branch.ts`).
- **SQL migrations** live in `apps/server/migrations`. The highest number is `2750_*`. Numbers 2743 and 2750 are each
  used by more than one file, so only the file names are unique. `2760_repo_component_rules.sql` is free.
- **The GuildwiseHQ remote** is `git@github.com:exinarium/GuildwiseHQ.git`. `normalizeRemoteUrl`
  (`packages/shared/src/ids.ts:100`) turns it into `github.com/exinarium/guildwisehq`. The repository has no other
  stable identity: the user chooses the project key and the repository name.
- **Glob matching**: `packages/shared` already has a `globToRegExp` with no dependencies
  (`packages/shared/src/workflows/high-risk.ts:124`; the file imports nothing).
  - It is used for high-risk paths and E2E areas.
  - It supports `*`, `**`, `**/` and `?`, and matches case-insensitively.
  - The runner has `picomatch`, but `packages/shared` is also bundled into the web app.
- **Version file**: `apps/runner/src/version.ts` is one line: `export const RUNNER_VERSION = '0.1.63';`.
- **No semver helper** exists. `runnerAtLeast` (`packages/shared/src/intake/spec-card.ts:25`) only compares versions,
  and only for runner checks.
- **Regex behaviour**, checked in Node 22 (the TypeScript lib is ES2023, so these features are typed):
  - Number of capture groups: `new RegExp('(?:' + p + ')|').exec('')!.length - 1`. Plain and named groups count.
    `(?:…)`, lookarounds, `\(` and `[(]` do not. Compile `new RegExp(p)` on its own first, so that the error message
    quotes the user's own pattern.
  - The `d` flag (`hasIndices`) gives `m.indices[1] = [start, end]` for the group. Replacing the string at those
    positions leaves every other character as it was, `\r\n` and a BOM included. Tested: `RUNNER_VERSION = '(.*)'` on
    `…'0.1.63';\r\nfoo\n` gives `0.1.63` at [31,37] and keeps the CRLF.
  - `.` never matches `\n` or `\r`, so the greedy `(.*)'` stays on its line.

## Options compared

### Storage: a JSONB column on `project_repos`, or a separate table

| | JSONB column `component_rules` | Table `repo_component_rules` |
|---|---|---|
| Read and write | The whole list. The editor saves it that way and parts 2 and 3 read it that way. | Rows. A save means delete and insert. |
| Rule order | The array keeps it. | Needs a position column. |
| Event | One `ProjectRepoComponentRulesSet { rules }`; easy to replay. | Same event, more projector code. |
| Queries across repositories | Not needed: a rule is only read for its own repository. | Possible, but not needed. |
| Fit with existing code | `known_branches` is already a JSONB column on this table. | A new table and new joins in `misc.ts`. |

**Choice: a JSONB column**, `NOT NULL DEFAULT '[]'::jsonb`.

### Glob matcher: reuse `globToRegExp`, or add `picomatch` to shared

Adding picomatch to shared would add it to the web bundle, and it would duplicate a matcher that already exists and
has tests. The rules only need `**`, `*` and `?`.

**Choice: reuse `globToRegExp`.**
- Documented syntax: `*`, `**` and `?`. Braces and character classes are not supported.
- Matching is case-insensitive. The worst case is that a component is bumped because a path matched in a different
  case.

### Where validation runs: the zod body schema, or the command

The body schema checks only the **shape** and the size limits, so a malformed request still gets `validation_error`.
The **semantic** checks (empty name, duplicate name, no globs, `..`, the number of capture groups) are in one shared
function, `componentRuleProblems()`, used in two places:
- the command, which throws `badRequest('invalid_component_rules', <message>, { problems })`, so the message names
  the problem;
- the web editor, which shows the same messages next to the fields before anything is sent.

The event schema also checks the shape only. If the rules become stricter later, old events must still replay.

### Seed: a data migration by remote URL, a SQL migration, or a default in code

- A SQL `UPDATE` would bypass the event store, so a rebuild of the projections would lose the rule.
- A default in code would break the constraint "do not hard-code the runner rule anywhere except the GuildwiseHQ seed".

**Choice: a boot data migration.** It appends `ProjectRepoComponentRulesSet` for every active repository whose
`remote_url_normalized = 'github.com/exinarium/guildwisehq'` and whose rules are still empty. The remote and the rule
are constants in that one file.

## Design

### 1. Shared: `packages/shared/src/repo/component-rules.ts` (new; export it from `repo/index.ts`)

```ts
import { z } from 'zod';
import { isSafeProjectPath } from '../safe.ts';
import { globToRegExp } from '../workflows/high-risk.ts';

export const COMPONENT_RULES_MAX = 20;

/** Shape only (size caps). The semantic checks are in componentRuleProblems(), so old events always replay. */
export const ComponentRuleSchema = z.object({
  name: z.string().max(60),
  paths: z.array(z.string().max(200)).max(20),
  versionFile: z.string().max(200),
  pattern: z.string().max(500),
});
export type ComponentRule = z.infer<typeof ComponentRuleSchema>;
export const ComponentRulesSchema = z.array(ComponentRuleSchema).max(COMPONENT_RULES_MAX);

export type ComponentRuleField = 'name' | 'paths' | 'versionFile' | 'pattern';
export interface ComponentRuleProblem { index: number; field: ComponentRuleField; message: string }

/** Number of capture groups, or null when the pattern does not compile. */
export function patternCaptureGroups(pattern: string): number | null;

/** Every problem of the list, in rule order. An empty array means valid. */
export function componentRuleProblems(rules: readonly ComponentRule[]): ComponentRuleProblem[];

/** Stored form: name trimmed, globs trimmed and blank ones dropped, a glob ending in "/" gets "**",
 *  versionFile without a leading "./". Call it after validating. */
export function normalizeComponentRules(rules: readonly ComponentRule[]): ComponentRule[];

/** Whether any changed file matches a glob of the rule, and which files did (part 2 counts them). */
export function componentRuleApplies(rule: ComponentRule, changedFiles: readonly string[]):
  { applies: boolean; matched: string[] };

export type VersionBump = 'patch' | 'minor' | 'major' | { version: string };

export type ReadVersionResult =
  | { ok: true; version: string; start: number; end: number }
  | { ok: false; reason: 'bad_pattern' | 'no_match' | 'empty'; message: string };
export function readComponentVersion(rule: ComponentRule, text: string): ReadVersionResult;

export type BumpResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'not_semver' | 'invalid_version' | 'not_higher'; message: string };
export function bumpVersion(current: string, bump: VersionBump): BumpResult;

/** Semver precedence: <0, 0 or >0; null when either is not semver. */
export function compareSemver(a: string, b: string): number | null;

export type ReplaceVersionResult =
  | { ok: true; from: string; to: string; text: string }
  | { ok: false;
      reason: 'bad_pattern' | 'no_match' | 'empty' | 'not_semver' | 'invalid_version' | 'not_higher';
      message: string };
/** bump defaults to 'patch'. */
export function replaceComponentVersion(rule: ComponentRule, text: string, bump?: VersionBump): ReplaceVersionResult;
```

#### Validation messages

A rule is named `Rule "<name>"` in a message, or `Rule <n>` when its name is empty.

| Problem | Message |
|---|---|
| Name empty after trim | `Rule 2: give the rule a name.` |
| Name used twice (trimmed, case-insensitive) | `Rule "runner": another rule already has this name.` |
| No globs, or only blank ones | `Rule "runner": add at least one path glob (like apps/runner/**).` |
| A glob that starts with `/`, has a `..` segment or contains `\` | `Rule "runner": path globs are relative to the repository root and cannot contain "..".` |
| Version file empty, absolute, `.` or containing `..`, a `.git` segment or `\` (rule: non-empty, passes `isSafeProjectPath`, not the root) | `Rule "runner": the version file must be a path inside the repository and cannot contain ".." (like apps/runner/src/version.ts).` |
| Pattern does not compile | `Rule "runner": the pattern is not a valid regular expression (<engine message>).` |
| Capture groups ≠ 1 | `Rule "runner": the pattern needs exactly one capture group around the version; it has 0.` (or 2, …) |
| More than 20 rules | Refused by the schema limit. |

#### Behaviour

- **Pattern flags**: the pattern is compiled with `'md'`.
  - `m` makes `^` and `$` work per line, which suits version lines in TOML or INI files.
  - `d` gives the indices of the capture group.
  - There is no `g` flag, so the **first** match is used.
- **componentRuleApplies**:
  - Each changed path is normalised: `\` becomes `/` and a leading `./` is removed.
  - The rule applies when at least one path matches at least one glob.
  - `matched` keeps the input order.
  - An empty `changedFiles` gives `applies: false`.
- **readComponentVersion** runs the pattern on the text:
  - No match: `no_match` ("the pattern … was not found in <versionFile>").
  - The group is undefined or empty: `empty`.
  - Otherwise it returns the group text and its `[start, end)`.
- **bumpVersion**:
  - A version is semver when it matches `^(v?)(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`. A leading
    `v` is kept.
  - `patch`, `minor` and `major` work like `npm semver inc`. A `patch` bump of the pre-release `1.2.3-rc.1` gives
    `1.2.3`. `minor` and `major` reset the lower parts and drop pre-release and build metadata.
  - An explicit `{ version }` must be semver (else `invalid_version`) and higher than the current version (else
    `not_higher`). Pre-releases are compared by semver §11.
  - If the current version starts with `v` and the explicit one does not, the `v` is added, so the file keeps its style.
  - A current value that is not semver gives `not_semver`.
- **replaceComponentVersion** reads the version, bumps it, and returns
  `text.slice(0, start) + to + text.slice(end)`.
  - **Nothing else in the text changes**: no trim, no newline normalisation, no reformatting.
  - Only the first match is changed.
- **No I/O**: the functions read no files and no clock. The runner (part 3):
  - reads the file as UTF-8;
  - writes it back unchanged outside the version span;
  - caps the file size (for example at 1 MB) before it runs the user's pattern.

### 2. Server

- **SQL migration** `apps/server/migrations/2760_repo_component_rules.sql`:
  ```sql
  -- Component version rules of a repository (name, path globs, version file, pattern); empty: none.
  ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS component_rules jsonb NOT NULL DEFAULT '[]'::jsonb;
  ```
- **Event** in `packages/shared/src/events/project.ts`, next to `ProjectRepoMainBranchSet`:
  ```ts
  /** The owner replaced the component version rules of a repository (empty: none); a release bumps those whose files changed. */
  defineEvent('ProjectRepoComponentRulesSet',
    z.object({ projectId: Id, repoId: Id, rules: ComponentRulesSchema, setBy: Id.optional() })),
  ```
  Import `ComponentRulesSchema` from `../repo/component-rules.ts`. That module imports only zod, `safe.ts` and
  `high-risk.ts`, so there is no import cycle.
- **Projector** (`apps/server/src/projections/projects.ts`): run
  `UPDATE project_repos SET component_rules=$2::jsonb WHERE id=$1` with `JSON.stringify(p.rules)`.
  `ProjectRepoAdded` does not touch the column. A new repository starts with `[]`, and a repository that is removed and
  added again keeps its rules.
- **Command** in the new file `apps/server/src/commands/component-rules.ts` (parts 2 and 3 add their release code next
  to it):
  ```ts
  export async function setRepoComponentRules(ctx, user, projectId, repoId, rules: ComponentRule[]): Promise<void>
  ```
  1. Run `componentRuleProblems(rules)` before the transaction. If it finds problems, throw
     `badRequest('invalid_component_rules', problems.map((p) => p.message).join(' '), { problems })`.
  2. Run `normalizeComponentRules(rules)`.
  3. Inside `withAppendTx`: call `loadVisibleProject`, check that the user is the owner
     (`forbidden('only the project owner can do this')`), and load the repository row
     (`SELECT id, component_rules …`, `notFound` when missing).
  4. If `JSON.stringify(row.component_rules ?? [])` equals `JSON.stringify(normalized)`, return without an event.
  5. Append `ProjectRepoComponentRulesSet { projectId, repoId, rules: normalized, setBy: user.id }` with actor
     `userActor` and scope `projectScope`.

  No runner command is needed.
- **API**:
  - In `packages/shared/src/api/projects.ts`:
    - add `componentRules: ComponentRulesSchema.optional()` to `ProjectRepoDtoSchema`, with the doc comment "The
      component version rules (expert mode); empty: a release only gets the release version.";
    - add `componentRules: ComponentRulesSchema.optional()` to `PatchRepoRequestSchema`. The client sends the full
      list, or `[]` to clear it. Add `b.componentRules !== undefined` to the `.refine`, and change its message to
      `send forge, projectPath, accessMethod, mainBranch or componentRules`.
  - Route `apps/server/src/routes/projects.ts:458`: add
    `if (req.body.componentRules !== undefined) await setRepoComponentRules(…)`.
  - `apps/server/src/queries/misc.ts` (the repository mapping, around line 294): add
    `componentRules: r.component_rules ?? []`. Parse it with `ComponentRulesSchema.catch([])`, so a bad row never
    breaks the project page.
- **Seed**: a new data migration in `apps/server/src/data-migrations/guildwisehq-runner-rule.ts`, named
  `guildwisehq-runner-rule-2026-10`. Add it at the end of `DATA_MIGRATIONS` and re-export it from `index.ts`.
  ```ts
  const GUILDWISEHQ_REMOTE = 'github.com/exinarium/guildwisehq';
  const RUNNER_RULE: ComponentRule = {
    name: 'runner', paths: ['apps/runner/**'], versionFile: 'apps/runner/src/version.ts',
    pattern: "RUNNER_VERSION = '(.*)'",
  };
  ```
  1. If `data_migrations` already has its name, return null.
  2. Select the repositories:
     ```sql
     SELECT pr.id, pr.project_id, p.org_id
       FROM project_repos pr JOIN projects p ON p.id = pr.project_id
      WHERE pr.remote_url_normalized = $1 AND pr.removed_at IS NULL AND pr.component_rules = '[]'::jsonb
     ```
  3. For each one, append `ProjectRepoComponentRulesSet` with `SYSTEM_ACTOR` and `projectScope(org_id, project_id)`,
     and log it.
  4. Record `{ changed: [repoIds] }` in `data_migrations`.

  The migration never overwrites rules the owner has already set. A GuildwiseHQ repository added after the migration
  has run gets no rule automatically; the owner adds it in the editor. The guide says so.

### 3. Web

- **Hook** `useSetRepoComponentRules(projectId)` in `apps/web/src/api/queries/forges.ts`, built like
  `useSetRepoMainBranch`. It calls `patch(…/repos/:repoId, { componentRules })` and then invalidates
  `['project', projectId]`.
- **Component** `apps/web/src/components/RepoComponentRulesControl.tsx`, props `{ projectId, repo, isOwner }`,
  `data-testid="repo-rules-<repo name>"`.
  - **Summary row**: the label **Component version rules**, then `none`, or one monospace line per rule such as
    `runner: apps/runner/** → apps/runner/src/version.ts`. The owner gets an **Edit** button. **Cancel** discards the
    draft.
  - **Editing**: the editor works on a draft copy of the list. Each rule is a fieldset **Rule n** with:
    - **Name**: TextInput.
    - **Path globs**: TextArea, one glob per line.
    - **Version file**: TextInput.
    - **Pattern**: TextInput, with the hint `The version inside one ( ), like RUNNER_VERSION = '(.*)'`.
    - **Remove rule**: a button with `aria-label="Remove rule <name>"`.
  - **Buttons below the list**: **Add rule** and **Save rules**.
    - **Save rules** first runs `componentRuleProblems` and shows each message under its field (TextInput `error`,
      matched by `index` and `field`).
    - When there are no problems, it sends the full list.
    - Server errors are shown in an `ErrorBox`.
    - Removing the last rule and saving sends `[]`.
  - **Touch and soft keyboard** (standing order "design"):
    - On narrow screens the fields are full width (`flex-col`, then `sm:flex-row`).
    - The glob, version file and pattern fields get `autoCapitalize="off"`, `autoCorrect="off"`, `spellCheck={false}`
      and `inputMode="text"`.
    - Buttons are at least 44px tall.
    - **Add rule** moves the focus to the new rule's Name field. Opening the editor focuses nothing, so the keyboard
      does not appear unasked.
- **ProjectSettings**: in `apps/web/src/pages/ProjectSettings.tsx`, around line 334, after `WorkingBranchControl`, add:
  ```tsx
  {traits.usesRepos && expert && (
    <RepoComponentRulesControl projectId={id} repo={r} isOwner={project?.myRole === 'owner'} />
  )}
  ```
  `expert` is already defined (line 66). The repositories panel is already hidden in business mode, so the editor is
  too.
- **MSW mocks**: if `apps/web/src/mocks/handlers.ts` mocks the repository PATCH, make it accept `componentRules` and
  return it.

### 4. Docs

In `docs/USER-GUIDE.md`:
- **Section 4.3, the Repos bullet** (around line 505): add one sentence saying that in expert mode each repository also
  has **Component version rules**.
- **The expert-mode part of 4.4** (around line 663): add a short paragraph that covers:
  - what a rule is: a name, path globs, a version file and a pattern with one capture group;
  - the runner rule as the example;
  - the glob syntax: `*`, `**` and `?`;
  - that only the first match of the pattern is changed;
  - that GuildwiseHQ comes with the runner rule;
  - that nothing uses the rules until "Ship release" is available.

## Acceptance criteria, design and tests

**AC 1. In expert mode the editor is shown; outside it, it is hidden.**
- Design: the `traits.usesRepos && expert` condition in ProjectSettings, and the new component.
- Test: `apps/web/src/test/component-rules.test.tsx` renders ProjectSettings with `me.user.gitExpert` true (the editor
  is there) and false (`queryByTestId` returns null). It also checks that adding, editing and removing rules send the
  right PATCH body, and that a bad pattern is refused in the browser without a PATCH.

**AC 2. A valid rule saves and is returned after a reload.**
- Design: PATCH `componentRules` → event → JSONB column → DTO field `componentRules`.
- Test: `apps/server/test/component-rules.test.ts` sends the PATCH, then GETs the project and expects the normalised
  rule. It also checks that `[]` clears the rules and that a non-owner gets 403.

**AC 3. Each bad rule is refused with a message that names the problem:** zero or two-plus capture groups, an invalid
regex, an empty glob list, a duplicate name, and `..` in the version file.
- Design: `componentRuleProblems` in the command → `400 invalid_component_rules`.
- Tests: a shared unit test for each case checks the message text. The server test checks that each case gets a 400
  whose `error.message` names the problem, and that nothing is stored.

**AC 4. After the migration the GuildwiseHQ repository has the runner rule; other repositories have none.**
- Design: the `guildwisehq-runner-rule-2026-10` data migration.
- Test: `guildwisehq-runner-rule-migration.test.ts` sets up two repositories: one with the remote
  `git@github.com:exinarium/GuildwiseHQ.git` and one other.
  - After `migrateGuildwiseRunnerRule`, only the first has the rule.
  - A second run changes nothing.
  - A repository whose owner already set rules keeps them.

**AC 5. The helper reports "applies" only when a changed file matches a glob, reads the version, and replaces only the
captured version (patch by default, or a given version).**
- Design: `componentRuleApplies`, `readComponentVersion`, `replaceComponentVersion` and `bumpVersion`.
- Tests, in `packages/shared/test/component-rules.test.ts`:
  - **Globs**: a match, no match, several globs, `**` several folders deep, a path with backslashes, and an empty list.
  - **Reading**: the version is read through the pattern.
  - **Replacing**: the text outside the version span stays byte-identical (with CRLF, a second line and a BOM).
  - **Bumps**: patch, minor and major; an explicit version that is higher (accepted), equal (refused) or lower
    (refused); a pre-release; a `v` prefix; a current value that is not semver.
  - **Patterns**: no match, 0, 1 and 2 capture groups, an invalid regex.

The server tests need the test Postgres that `apps/server/test/helpers` uses. If the build sandbox cannot reach it, the
builder runs the shared and web unit tests and names the server test suites for the tester.

## Risks and traps

- **Do not put the semantic checks in the zod schemas** (body or event). In the body schema, a failed refine gives the
  generic "request validation failed", so the criterion "a message naming the problem" fails. In the event schema it
  would break the replay of old events.
- **Slow patterns (ReDoS)**: the server only compiles the pattern and runs it on `''`. The pattern runs on real text
  only in the runner (part 3), on a small file with a size cap. The pattern itself is capped at 500 characters.
- **First match only**: if the pattern matches twice, only the first match changes. The guide says so.
- **Case-insensitive globs** are accepted (see the options above).
- **Seed by remote URL**: a fork or a mirror under another URL gets no rule. That is intended, because the rule may only
  be set by the seed.
- **Business mode**: the repositories panel is not shown there, so the editor is not shown either. Nothing more is
  needed.
- **No release behaviour in this card**: no runner commands and no desk items. Parts 2 to 4 use `componentRuleApplies`,
  `replaceComponentVersion`, `bumpVersion` and `compareSemver`. Part 2 also uses `compareSemver` to refuse a release
  version that is not higher than the last tag.
