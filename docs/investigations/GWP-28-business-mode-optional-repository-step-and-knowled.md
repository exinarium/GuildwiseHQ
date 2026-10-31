# GWP-28: Business mode setup checklist (no repository step; Knowledge, Rules and Connections steps)

First read against GuildwiseHQ `main` at 22ec5267 (2026-10-29). Checked again on 2026-10-31 against the working branch at
2c6b4688, after the organization mode flag (GWP-27), the document vault (GWP-25) and output delivery (GWP-32) landed.
See "Review against the landed code" just below. Where the review changes the design, the sections further down are
already updated.

## Review against the landed code (2026-10-31)

| # | Assumption | Result | What changes |
|---|---|---|---|
| 1 | Org mode stored server-side; `isBusinessOrg` exported from `@aom/shared` | **Holds, but GWP-27 also changed this card's file.** `organizations.mode text NOT NULL DEFAULT 'dev'` (migration `2750_org_mode.sql`, check `dev`/`business`). `isBusinessOrg(org)` and `isDevOnlyRoleKey` are in `packages/shared/src/orgs/mode.ts`. Commit 7a6eed02 already edited `queries/setup-checklist.ts`. It reads `mode` with `plan, features`. In business orgs it drops the `repository` step (a `splice` after the literal) and the team step needs only the BA (`missing` without dev-only roles, hint "A business analyst.", link `/agents?hire=ba`). `apps/server/test/setup-checklist.test.ts` has a business test that asserts ids `project, workstation, team, ba` and team `missing: ['business analyst']`. | Build on what landed, don't redo it. The mode lookup is there already. The team step keeps GWP-27's rule (done when the BA is hired, `missing` list, link `/agents?hire=ba`). That replaces this design's earlier "≥1 non-DevOps agent, no missing list". Update GWP-27's business test to the new step list (it is expected to change). |
| 2 | Builder, reviewer, tester and DevOps can't be hired in business orgs; the BA can | Holds. `commands/agents.ts` calls `assertDevMode` for `DEV_ONLY_ROLE_KEYS` (`builder, reviewer, pre_reviewer, tester, devops`). | None (see 1 for the team step). |
| 3 | Projects and boards stay in business orgs | Holds. Only repository commands (`projects.ts`, `repo-create.ts`), git-URL packs and dev hires are refused. | None. |
| 4 | GWP-25 keeps documents (uploads too) in `documents`, with removed ones archived | Holds. `2750_document_tags_files.sql` adds kind `file` and `file_*` columns to `documents`. Bytes go to `document_file_data`. Status still ends in `archived`, and nothing deletes rows. `/documents` has an Upload action (`uploadDocument`, managers only). | The Knowledge link is now `/documents` (the condition in the earlier design is met). The document half of the Knowledge check also leaves out documents an agent drafted from a chat (see Knowledge below). Otherwise talking to the BA would tick Knowledge by itself. |
| 5 | GWP-32 not needed; today's webhook/email automations count | **Does not hold.** GWP-32 merged (0c3324f7). Its delivery destinations (`email`, `webhook`, `whatsapp`, `google_sheet`) sit in `schedules.action->'deliverOutput'->'destinations'` on `create_card` schedules (`DeliverOutputSchema`, `packages/shared/src/events/schedule.ts`). There is no new table. | The Connections query also counts a schedule with at least one `deliverOutput` destination. |

Also noted: migration numbers now run to 2750 (three files), so the `note_count` migration takes the next free number
(2751 or later). The web checklist was not touched by GWP-27. It still says "Five steps" while a business org sees four,
and section 4 fixes that.

## The question

The "Get started" checklist has to work for an org that has no repository. Business orgs:

- never see the repository step, and the checklist completes without it;
- get three new steps (Knowledge, Rules, Connections), each with a title, a one-line plain hint, a done check computed on
  the server and a link;
- must finish Knowledge and Rules; Connections is recommended, not required;
- only ever see the words "Knowledge" and "Rules & decisions", never "Vault" or "Ledger".

Dev orgs must get exactly the checklist they get today.

## Findings

### Today's checklist (after GWP-27)

- `apps/server/src/queries/setup-checklist.ts` `getSetupChecklist(ctx, userId, orgId, role)` reads
  `organizations.plan, features, mode`, then runs `project`, `withRepo`, `ws`, `hired` and `talked`. It builds five steps
  inline (`project`, `repository`, `workstation`, `team`, `ba`). In a business org it splices out `repository`, and the
  team `missing` list leaves out dev-only roles. It returns `{ steps, doneCount, complete, dismissed }`, where `doneCount`
  and `complete` count only steps with `!s.optional`. Today no step sets `optional`.
- Business text left over from GWP-27 that this card must change: the project hint says "its repositories", and the
  workstation hint says "A DevOps engineer for it is hired automatically."
- `packages/shared/src/api/setup.ts`: `SETUP_STEP_IDS = ['project','repository','workstation','team','ba']`, a `z.enum`.
  `SetupStepSchema` already has `optional?: boolean` (its comment still talks about the CEO step that was removed).
  `SETUP_TEAM_ROLES = ['ba','builder','reviewer','tester']`.
- `apps/server/src/routes/setup-checklist.ts`: GET and PUT. Both parse with `SetupChecklistSchema`. No change needed.
- `apps/web/src/components/setup/SetupChecklist.tsx` (unchanged by GWP-27):
  - `requiredSteps = (c) => c.steps` returns every step. If an optional step were added, the widget would show "x/7"
    while `complete` uses 6. **This has to change to `c.steps.filter(s => !s.optional)`.**
  - `StepRow` picks the button label from `step.id` (`workstation` Add, `team` Hire, `ba` Talk, otherwise Start).
  - `SetupChecklistDialog` hard-codes "Five steps from an empty organization ...".
  - `SetupHelpCard` hard-codes "All five steps are done." and "...: project, repository, workstation, team and the
    business analyst."
- `apps/web/src/api/queries/setup.ts`: `useSetupChecklist` and `useSetChecklistDismissed`. No change needed.
- Tests: `apps/server/test/setup-checklist.test.ts` (DB-backed, `createWorld`, dev ids and links, plus GWP-27's business
  case) and `apps/web/src/test/setup-checklist.test.tsx` (asserts `1/5`, `All five steps are done.`).
  `e2e/video/getting-started.spec.ts` uses the dev step ids.
- Guildwise Cloud never imports `SetupStep`, `SETUP_STEP_IDS` or the checklist, so adding enum values is safe for it.

### Team step in business mode

GWP-27 makes the server refuse builder, reviewer, pre-reviewer, tester and DevOps hires in a business org. It already
narrowed the business team step to "the BA is hired" (`missing: ['business analyst']` until then, link
`/agents?hire=ba`). That meets requirement 5 ("first agent hire"), because the BA is the one built-in role a business org
hires. **Keep that rule.** This card only changes the business text (see the step table).

### Data for the new done checks

**Knowledge.** This is the hard one.

- `vaults` (kinds `org | personal | project`; `storage git | local`). `ensureProjectVaultIn` and `ensureOrgVaultIn`
  (`apps/server/src/commands/vaults.ts`) **create a local project vault for every project, and an org vault, by themselves**
  once the owner's workstation connects. So "a vault row exists" is true for nearly every org and tells us nothing.
- `workstation_vaults` (operational, written by `markVaultStatus` from the runner's `vault.status`) records that a runner
  holds the vault. It has no file or note count. The server never sees what is inside a vault.
- Files the system writes into a vault itself, which must not count as the user's notes: `standing-orders.md` (root and
  project folders, the ledger mirror), `<folder>/taste.md`, `org/graph/**` and `<folder>/graph/**`, `delivery/**`,
  `.git/**`.
- `documents` (GWP-25 landed): `kind brief|prd|minutes|session_log|file`, `status ...|archived`,
  `source_thread_ids uuid[]`, `created_by`. Users write documents through `createDocument` and `uploadDocument` (managers
  only). An upload has `kind 'file'` and `sourceThreadIds: []`. **Agents also create documents**: `sessions/board.ts` and
  `sessions/discovery-verbs.ts` append `DocumentCreated` with `sourceThreadIds: [threadId]` and `createdBy` set to the
  thread's user. A BA chat can therefore leave a brief behind, and counting every non-archived document would tick
  Knowledge as a side effect of the `ba` step.

**Rules.** `ledger_entries` with `scope = 'standing_order' AND superseded_by IS NULL AND retired_at IS NULL` (the
`ledger_entries_live` index). Org and project orders both count. Rule packs write ordinary standing orders. GWP-39 review
dates (`2750_ledger_review_date.sql`) do not retire an order, so they do not affect the check. The page is `/ledger`
("Rules & decisions" after GWP-29).

**Connections.**

- MCP: `projects.mcp_servers text[]` (Owner only, `setProjectMcpServers`). "Granted to the org" means any active project
  with a non-empty list.
- Delivery destinations for automations (two shapes, both in `schedules.action jsonb`; the projection deletes the row when
  a schedule is removed):
  - digest actions `{kind:'integration', integration:'webhook'|'email'}`;
  - GWP-32 output delivery: `create_card` actions with `deliverOutput.destinations[]` (`email`, `webhook`, `whatsapp`,
    `google_sheet`). WhatsApp and Sheets credentials stay on the runner, and the server only holds the destination
    settings.
- `delivery_recipes` (2224) is **deploy** delivery, a dev surface. It must **not** count.
- Neither source needs a cloud token store (open owner decision (c) stays open).

## Options for the Knowledge done check

| Option | What counts | Meets "at least one note" | Cost | Risk |
|---|---|---|---|---|
| K1: vault row exists | any `vaults` row | No (auto-created vaults make it always true) | none | Ticks itself with an empty vault: wrong |
| K2: documents only | a user's non-archived document | Only for documents, not notes on the runner | one query | Ignores the runner vault the card names |
| K3: runner note count + user documents (recommended) | runner-reported `noteCount > 0` on an org/project vault, **or** a non-archived document the user wrote or uploaded | Yes | additive protocol field, one column, a small runner walk | An old runner reports no count: only documents tick it until the runner is updated |
| K4: wait for a server-hosted vault | – | – | – | Owner decision (b), out of scope |

**Recommendation: K3.** It is the only option that checks "with at least one note" on today's local runner vault, and it
also counts GWP-25 uploads. The runner change is additive, like `localPath` on `vault.status`.

Scope note: `apps/runner` is in the same GuildwiseHQ repository. The card's list of areas is there to keep the build out
of the `agent-org-manager` copy. If review rejects a runner change, the fallback is K2 with the hint naming documents only.

## Design

### 1. Shared (`packages/shared/src/api/setup.ts`), additive only

```ts
export const SETUP_STEP_IDS = ['project', 'repository', 'workstation', 'team', 'ba', 'knowledge', 'rules', 'connections'] as const;
// SetupStepSchema: unchanged shape. Fix the `optional` comment:
/** Recommended, not needed to finish the checklist (a business org's Connections step). Shown, never counted. */
```

`packages/shared/src/protocol/runner.ts` `VaultStatusSchema`, additive:

```ts
/** Additive: how many notes the vault holds (Markdown files the user wrote; generated files left out), counted up to MAX_VAULT_NOTE_COUNT. Absent from older runners. */
noteCount: z.number().int().nonnegative().optional(),
```

plus `export const MAX_VAULT_NOTE_COUNT = 1000`. Do not bump `PROTOCOL_VERSION`.

### 2. Runner (`apps/runner/src/vaults/`)

- New `notes.ts`: `countVaultNotes(root: string, cap = MAX_VAULT_NOTE_COUNT): number`. A synchronous, bounded walk with
  `readdirSync(..., { withFileTypes: true })`. It skips symlinks, directories whose name starts with `.`, and directories
  named `graph` or `delivery`. It counts `.md` files (case-insensitive) other than `standing-orders.md` and `taste.md`
  (`TASTE_FILE` from shared). It stops at `cap`, and returns 0 on any error.
- `manager.ts`: add `noteCount: countVaultNotes(dir)` to `vault.status` from `reportLocal` (local vaults) and from the
  `status === 'ok'` branch of `afterSync` (git vaults). Leave the conflict and error branches alone.

### 3. Server

**Migration** `apps/server/migrations/<next>_vault_note_count.sql` (the next free number; 2750 is the latest today):

```sql
-- How many notes a workstation's copy of a vault holds (runner-reported, best effort; NULL: not reported yet).
ALTER TABLE workstation_vaults ADD COLUMN IF NOT EXISTS note_count integer;
```

**`markVaultStatus`** (`commands/vaults.ts`): accept `noteCount?: number`. Insert it, and on conflict
`note_count = COALESCE(EXCLUDED.note_count, workstation_vaults.note_count)`. `runner-gateway/handlers.ts` already passes
the parsed `msg`.

**`queries/setup-checklist.ts`**: build on the GWP-27 version (mode read with `plan, features`, `business` flag,
`missing` without dev-only roles). Split facts from steps so the step logic can be unit-tested without a database.
Replace the post-hoc `splice` with a business branch in the builder.

```ts
export interface SetupFacts {
  business: boolean;
  manager: boolean;
  intakeOn: boolean;
  project: { id: string } | null;
  withRepo: boolean;          // dev only (not queried in business orgs)
  workstation: boolean;
  missing: string[];          // SETUP_TEAM_ROLES not hired; dev-only roles left out in business orgs (as landed)
  talked: boolean;
  knowledge: boolean;         // business only
  rules: boolean;             // business only
  connections: boolean;       // business only
}
export function buildSetupSteps(f: SetupFacts): SetupStep[] { ... }   // pure
export function summarize(steps: SetupStep[]) { const required = steps.filter(s => !s.optional); ... }
```

A dev org runs exactly the queries it runs today. A business org skips `withRepo` and runs the three queries below.

```sql
-- knowledge: a note on the runner, or a document the user wrote or uploaded (not one an agent drafted from a chat)
SELECT 1 WHERE EXISTS (SELECT 1 FROM documents d WHERE d.org_id = $1 AND d.status <> 'archived'
                         AND (d.kind = 'file' OR cardinality(d.source_thread_ids) = 0))
   OR EXISTS (SELECT 1 FROM workstation_vaults wv
                JOIN vaults v ON v.id = wv.vault_id AND v.org_id = $1 AND v.kind IN ('org','project')
                JOIN workstations w ON w.id = wv.workstation_id AND w.status = 'active'
               WHERE wv.note_count > 0)
-- rules
SELECT 1 FROM ledger_entries WHERE org_id = $1 AND scope = 'standing_order'
   AND superseded_by IS NULL AND retired_at IS NULL LIMIT 1
-- connections: an MCP grant, a digest webhook/e-mail automation, or an automation that delivers its output (GWP-32)
SELECT 1 WHERE EXISTS (SELECT 1 FROM projects p WHERE p.org_id = $1 AND p.status = 'active'
                        AND cardinality(p.mcp_servers) > 0)
   OR EXISTS (SELECT 1 FROM schedules s WHERE s.org_id = $1
                AND ((s.action->>'kind' = 'integration' AND s.action->>'integration' IN ('webhook','email'))
                     OR jsonb_array_length(COALESCE(s.action->'deliverOutput'->'destinations', '[]'::jsonb)) > 0))
```

The `personal` vault kind is left out on purpose: it belongs to one member, not to the org. A document a user creates by
hand from a chat (`createDocument` with `sourceThreadIds`) is not counted. That is acceptable: an upload or a note is the
plain way to add knowledge, and the hint says so.

**Dev steps**: exactly today's five steps (same order, titles, hints, links, `missing`). Move the existing literal into
`buildSetupSteps` unchanged.

**Business steps**, in this order (plain text; no "repository", "Vault", "Ledger", "DevOps"):

| id | title | hint | done | actionable | link (when not done and actionable) | optional |
|---|---|---|---|---|---|---|
| project | Create your first project | A project holds a board of cards and the team that works on it. | as today | manager | `/projects?new=1` | – |
| workstation | Add a workstation | The computer that runs your agents: your own machine or a server you rent. | as today | true | `/workstations?add=1` | – |
| team | Hire your team | A business analyst: they turn what you describe into cards for the team. | as landed by GWP-27: `missing` empty (BA hired) | true | `/agents?hire=${missing[0]}` (= `/agents?hire=ba`) | – |
| knowledge | Add something to Knowledge | Upload a document or write a note your agents should know about your business. | knowledge query | manager | `/documents` | – |
| rules | Set your first rule | Add a standing order in Rules & decisions: something your agents must always or never do. | rules query | manager | `/ledger` | – |
| ba | Talk to the business analyst | as today | as today | true | as today | – |
| connections | Connect a tool or a destination | Recommended: let your agents use one of your tools, or send their results to an e-mail address, a chat or a sheet. | connections query | manager | `/automations` | `true` |

- The team step keeps its `missing` list (`['business analyst']` until the BA is hired), as GWP-27's test expects.
- Required in business orgs: project, workstation, team, knowledge, rules, ba (6). Connections is optional. If the owner
  reads requirement 5's parenthesis as the complete list, dropping `ba` from the business set is a one-line change.
- Steps without a link for the viewer (Members) show "An Owner or Admin does this step." as today.
- The text is plain UI copy. It is not rule-pack or role text from the owner's research file, so that file is not needed.

### 4. Web (`apps/web/src/components/setup/SetupChecklist.tsx`)

- `requiredSteps = (c) => c.steps.filter((s) => !s.optional)`. Update its doc comment. The widget count, the progress bar
  and the Help count all come from it.
- `StepRow`: button label from a map, `{ workstation: 'Add', team: 'Hire', ba: 'Talk', knowledge: 'Add', rules: 'Add',
  connections: 'Connect' }`, otherwise 'Start'. When `step.optional`, show a small "Recommended" tag next to the title
  (`data-testid="setup-optional-<id>"`). Keep the 44 px touch target on coarse pointers (`[@media(pointer:coarse)]:h-11`).
- `SetupChecklistDialog` description: `${Cap(numberWord(total))} steps from an empty organization to a team that works.
  Each one ticks itself off.` For dev that is still "Five steps ...". Add `numberWord` (one to ten, digits after that).
- `SetupHelpCard`: `All ${numberWord(total)} steps are done.` and
  `${doneCount} of ${total} steps done: ${listJoin(required.map(shortName))}.` with `SHORT = { project: 'project',
  repository: 'repository', workstation: 'workstation', team: 'team', ba: 'the business analyst', knowledge: 'Knowledge',
  rules: 'Rules & decisions', connections: 'connections' }` and an "a, b and c" join. For dev this gives exactly today's
  sentence.
- Dismissed state: unchanged. `apps/web/src/api/queries/setup.ts`: no change.
- GWP-29 (same group, next card) renames Vault and Ledger in the rest of the UI. This card's step text already uses the
  business names.

## Risks

- **Old runner**: no `noteCount`, so runner notes do not count until the runner is updated. Uploads still count.
- **Note heuristic**: a user note named `standing-orders.md` or kept under a `graph/` folder is not counted. Write the
  exclusions in one place (`notes.ts`) with a test.
- **Dev regression**: the step literal moves into `buildSetupSteps`. A snapshot unit test of the dev output guards it,
  and the existing dev DB tests stay unchanged.
- **GWP-27 business test**: its expected id list changes to the seven business steps. Change the expectation, and keep
  its team assertions (`missing`, link, done after hiring the BA).
- **Web count mismatch**: fixed by filtering `optional` in `requiredSteps`. Covered by a test.

## Acceptance criteria to design

| AC | Covered by |
|---|---|
| Business org: no repository step, completes without a repository | `buildSetupSteps` has no `repository` in the business branch; `summarize` counts only required steps. Unit test "business, all facts true, no repo: complete"; DB test with `mode='business'`; e2e walk (tester) |
| Knowledge, Rules, Connections appear, each turns done when its condition holds, each links to its page | Business queries plus a pure builder. Unit test per fact flipping one step. DB tests: upload a document / set `note_count` / add a standing order / grant an MCP server / create a webhook schedule / create a `create_card` schedule with `deliverOutput`. Web test renders the three rows with their links |
| Knowledge and Rules required, Connections optional; dialog count matches | `optional: true` only on connections; `requiredSteps` filters it. Server test: `doneCount`/`complete` ignore connections. Web test: 7 rows, widget `x/6`, dialog "Six steps", Recommended tag on connections |
| Dev org checklist identical | Dev branch is today's literal; dev queries unchanged; snapshot unit test; existing dev server and web tests stay green unchanged |
| Business text says Knowledge / Rules & decisions, never Vault / Ledger | Test over every business title and hint: `/vault|ledger|repositor|devops/i` never matches; `Knowledge` and `Rules & decisions` present |

## Tests (builder unless marked)

- `apps/server/test/setup-steps.test.ts` (new, pure, no DB): dev snapshot; business with nothing done (7 steps, no
  repository, `doneCount 0`, `complete false`); each of knowledge/rules/connections flips alone; team done when `missing`
  is empty; connections does not affect `complete`; wording check.
- `apps/server/test/setup-checklist.test.ts` (DB, extend; testers run it if the builder shift has no DB): update GWP-27's
  business case to the seven ids. Test each done transition from real rows, including `note_count` through
  `markVaultStatus`, a `deliverOutput` schedule, and three rows that must **not** tick: an agent-drafted document
  (`source_thread_ids` set, kind `brief`) for Knowledge, an archived upload for Knowledge, and a `delivery_recipes` row for
  Connections.
- `apps/runner/test/vault-notes.test.ts`: temp dir with `standing-orders.md`, `org/graph/drafts.md`, `.git/x.md`,
  `p/graph/a.md`, `delivery/r.md`, `p/taste.md` gives 0; add `notes/a.md` and the count is 1; a symlink is not followed;
  the cap is honoured.
- `apps/web/src/test/setup-checklist.test.tsx`: existing tests unchanged (dev). New case: business payload with 7 steps,
  connections optional. Check there is no `setup-step-repository`, the three new rows and their links (`/documents`,
  `/ledger`, `/automations`), the Recommended tag, `x/6`, "Six steps", and the Help sentence naming Knowledge and
  Rules & decisions.
- E2E (tester, `e2e/**` is tester-owned): a fresh business org walks to complete without a repository.
