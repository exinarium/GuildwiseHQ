# GWP-50: card shifts mount both the organization vault and the project vault

## Question

Builders should have the organization vault and their project vault, both read-only, when a shift starts. Today they
get one or neither. Why, and what is the root-cause fix that leaves CEO, BA, question, chat and DevOps shifts as they are?

## Root cause (confirmed by reading the code)

The planner's reading is right. Three places work together to drop a vault.

1. **Server: `buildShiftStart` resolves exactly one vault** (`apps/server/src/runner-gateway/brief.ts:662-664`,
   `vault: ... vaultForProject(...)` at line 686). `vaultForProject` (`apps/server/src/commands/vaults.ts:432-457`)
   is a priority chain that returns the first match only:
   1. the project's own **git** vault, else
   2. the **organization** vault, but only when the workstation's user is Owner or Admin (`isOrgManager`), else
   3. any project vault (the automatic **local** project vault, `ensureProjectVaultIn`).

   As a result:
   - A project with a git project vault **drops the organization vault** (org standing orders, `org/`, the org graph).
   - On a manager workstation, a project with an organization vault and a local project vault **drops the local project
     vault**. Every project gets one automatically when `projectGraphs.enabled` is on.
   - On a non-manager workstation, a project with no project vault gets **neither**. This part is intended: the
     organization vault is not synced to Members' workstations (`vaultConfigsFor`, owner decision 12), so no clone
     exists there.
2. **Protocol: `ShiftStart.vault` is singular** (`packages/shared/src/protocol/runner.ts:597-603` and `:1629-1630`),
   and `docs/ARCHITECTURE.md` 16.1 states the old rule: "A card reads only the vault of its project … the runner passes
   only that clone as `--add-dir`." The single-vault behaviour was the documented design and is now the defect.
3. **Runner: a card shift's vault is not a read-only folder.** In `ShiftSupervisor.run`
   (`apps/runner/src/shifts/supervisor.ts:1066-1083`), `vaultReadFolder` is built only when `msg.kind !== 'card'`. A
   card shift gets the vault only through `addDirs` (lines 1232 and 1359). This causes two problems:
   - The vault is **not listed under "Folders you can read"** (line 1170 renders only `readFolders`), so even the one
     vault a builder gets is invisible in its instructions.
   - `addDirs` are opened **whole** in the OS sandbox (`sandboxBlock`, `allowRead: [...ctx.addDirs]`), and
     `secretReadDenies` covers only `readDirs` (`readOnlyDenies`). So **secret files inside the vault are not blocked
     for card shifts**. Edit/Write are still denied (`Edit(<addDir>/**)` and `denyWrite`).

CEO, BA task and question shifts use `shiftVault` (brief.ts:611), which wraps the same `vaultForProject`, and chat uses
`vaultForConversation`. Those keep their single-vault shape: the card asks that they stay unchanged.

## Options compared

| Option | What | Verdict |
|---|---|---|
| A. Change `vaultForProject` to return a list | Every caller (`shiftVault`, chat, `ba-tasks` dispatcher, `spec-card`, reports) changes shape and the CEO/BA/question/chat mounts change | Rejected: breaks the "other shift kinds unchanged" constraint |
| B. Replace `ShiftStart.vault` with a list | Older runners would lose the vault entirely (they read only `vault`); writes (`aom publish`, vault reports, transcripts) need a single target | Rejected: not backward compatible |
| **C. New resolver for card shifts and an additive `vaults` list; `vault` stays the write target** | `vault` keeps today's value (the write target, unchanged behaviour for reports and publish). `vaults` lists every vault the card may read. The runner mounts every entry of `vaults` (or `[vault]` from an older server) as a read-only vault folder | **Recommended** |
| D. Runner special case for builder roles | Explicitly forbidden by the card | Rejected |

## Decision on the open point (organization vault on non-manager workstations)

**Keep the existing rule.** A card shift gets the organization vault only when the workstation's user is the
organization's Owner or an Admin. Reasons:
- The organization vault is only synced to Owner/Admin workstations (`vaultConfigsFor`, `vaultAudience`, owner decision
  12). On a Member's workstation there is no clone to mount, so including it would mount nothing and widen nothing in
  practice. A server that named it anyway would also contradict the audience rule.
- The card says "do not widen access silently". Changing who receives the organization vault is an owner decision
  that also touches vault sync. It is outside this bug.

Consequence: on a Member's workstation, a card shift of a project with a project vault still gets only the project
vault. A project without one gets no vault, exactly as today. That is the degrade path of AC 4.

**Scope inside the organization vault.** The whole organization vault clone is mounted (as today for a project without
its own vault, and as for CEO/BA/question shifts). It is only present on Owner/Admin workstations, whose user can see
every project of the organization, so no knowledge crosses organizations or reaches a user who cannot see it. Masking
the sibling `projects/<other>/` folders inside the organization vault would be a separate hardening step. I filed it as
a backlog suggestion; it is not part of this card.

**Which card roles.** The fix is in `buildShiftStart`, which serves every card shift: builder, reviewer, tester and
architect. All of them get both vaults. There is no role-name check anywhere (constraint: no role special case).

## Design

### 1. Shared protocol (`packages/shared/src/protocol/runner.ts`)

Additive field on `ShiftStartSchema`, next to `vault`:

```ts
/**
 * Card shifts: every vault the card may read, read-only (the organization vault and the project vault, each only when it
 * exists and this workstation's user receives it). `vault` stays the one vault writes go to (`aom publish`, a vault
 * report, transcripts). Absent (an older server): the runner reads `[vault]`.
 */
vaults: z.array(ShiftVaultSchema).max(4).optional(),
```

- `ShiftVaultSchema` is unchanged. Update its doc comment ("the one vault a card shift may read") to "a vault a shift
  may read".
- The `msg()` objects are non-strict, so an **older runner strips `vaults`** and keeps mounting `vault` as today. No
  `PROTOCOL_VERSION` bump and no capability flag are needed.
- An **older server** never sends `vaults`, so a newer runner falls back to `[vault]` (AC: old message shape still works).

### 2. Server resolver (`apps/server/src/commands/vaults.ts`)

Add one function next to `vaultForProject` and leave `vaultForProject` unchanged:

```ts
export interface CardVault { id: string; kind: 'org' | 'project'; folder: string }

/**
 * Every vault a card shift of `projectId` may read on a workstation of `workstationUserId` (docs/ARCHITECTURE.md 16.1):
 * the organization vault (only for the organization's Owner and Admins: it is synced to their workstations only) and the
 * project's own vault (git or local). `primary` is `vaultForProject`, the one vault writes go to.
 */
export async function vaultsForCard(
  db: Queryable,
  projectId: string,
  workstationUserId: string,
): Promise<{ primary: CardVault | null; all: CardVault[] }> {
  const p = await one(db, 'SELECT id, org_id, key, vault_folder, vault_dir FROM projects WHERE id=$1', [projectId]);
  if (!p) return { primary: null, all: [] };
  const folder = projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir });
  const primary = await vaultForProject(db, projectId, workstationUserId);
  const manager = isOrgManager({ orgRole: await orgRoleOf(db, workstationUserId, p.org_id) });
  const org = manager
    ? await one(db, `SELECT id, kind FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`, [p.org_id])
    : undefined;
  // one vault per project (registerVault refuses a second); prefer the synced one if both ever exist
  const own = await one(
    db,
    `SELECT id, kind FROM vaults WHERE project_id=$1 ORDER BY (storage='git') DESC, created_at, id LIMIT 1`,
    [projectId],
  );
  const found = [primary, org && { id: org.id, kind: org.kind, folder }, own && { id: own.id, kind: own.kind, folder }]
    .filter((v): v is CardVault => !!v);
  const all = [...new Map(found.map((v) => [v.id, v])).values()]; // primary first, de-duplicated by id
  return { primary, all };
}
```

Rules this encodes:
- **The primary vault comes first** in `all`. It is identical to today's `vault`, so reports, publish, transcripts and the
  `vaultAvailable` fallback in `buildShiftStart` behave exactly as before.
- The organization vault is included only on manager workstations, the same rule as today.
- The project vault is included whatever its storage. A local vault on another workstation has no clone here, and the
  runner skips it (see 3). There is no new membership check: `vaultForProject` has none for the project vault either,
  and clones exist only on project members' workstations (`vaultConfigsFor`).
- If neither exists, `all` is empty and `primary` is null. Nothing fails.

### 3. Server shift start (`apps/server/src/runner-gateway/brief.ts`, `buildShiftStart`)

Replace lines 662-664 and 686:

```ts
// Every vault this card may read (organization and project vault, each only if this workstation's user receives it);
// `vault` is the one writes go to.
const ws = await one(ctx.pool, 'SELECT user_id FROM workstations WHERE id=$1', [claim.workstationId]);
const vaults = ws ? await vaultsForCard(ctx.pool, brief.project.id, ws.user_id) : { primary: null, all: [] };
const vault = vaults.primary;
...
vault: vault ? { vaultId: vault.id, kind: vault.kind, folder: vault.folder } : null,
...(vaults.all.length > 0
  ? { vaults: vaults.all.map((v) => ({ vaultId: v.id, kind: v.kind, folder: v.folder })) }
  : {}),
```

Do **not** touch `shiftVault`, `buildQuestionShiftStart` (question-brief.ts:140), `buildBaTaskShiftStart`
(ba-task-brief.ts:211), the CEO pass (ceo/pass.ts:132), `vaultForConversation` (chat) or the DevOps shift start.
`ShiftStartPayload` picks up the new optional field from the schema.

### 4. Runner vault context (`apps/runner/src/vaults/context.ts`)

Keep `readVaultContext` and `withVaultContext` as they are: chat uses them. Add:

```ts
export interface VaultShiftContext { addDir: string; kind?: 'org' | 'project'; standingOrders: ...; projectDoc?; taste? }

/** The vaults of a shift, in order (the write target first), each read as `readVaultContext`; vaults with no clone here are skipped. */
export async function readVaultContexts(vaultsDir: string, vaults: ShiftVault[]): Promise<VaultShiftContext[]>
//  - de-duplicate by vaultId and by resolved addDir
//  - set `kind` from the ShiftVault
//  - when more than one context results, relabel the standing-order titles so the agent can tell them apart:
//      'Vault standing orders'              -> 'Organization vault standing orders' / 'Project vault standing orders'
//      'Project standing orders (vault)'    -> 'Project standing orders (organization vault)' / '(project vault)'
//    With one context the titles stay exactly as today (no text change for single-vault shifts).

/** Merges several vaults into the brief: standing orders of all (first vault first; identical bodies once), PROJECT.md
 *  and taste.md from the first vault that has them. */
export function withVaultContexts(brief: ShiftBrief, ctxs: VaultShiftContext[]): ShiftBrief
```

`withVaultContexts(brief, [c])` must equal `withVaultContext(brief, c)`. Implement one in terms of the other.

### 5. Runner supervisor (`apps/runner/src/shifts/supervisor.ts`, `run`, lines 1066-1083, 1169-1174, 1225-1234, 1359-1364)

```ts
// The vaults this shift reads (read-only). A card shift reads every vault the server named (`vaults`; an older server
// sends only `vault`); question, BA task and CEO shifts read their one `vault`; a DevOps shift reads none.
const shiftVaults: ShiftVault[] =
  msg.kind === 'card' ? (msg.vaults?.length ? msg.vaults : msg.vault ? [msg.vault] : [])
  : msg.kind === 'question' || msg.kind === 'ba_task' || msg.kind === 'ceo' ? (msg.vault ? [msg.vault] : [])
  : [];
const vaultCtxs = await readVaultContexts(paths.vaults, shiftVaults);
// Every vault opens as a read-only folder (secret files blocked, like a reference repository), for every shift kind.
const vaultReadFolder: ReadableFolder[] = vaultCtxs.map((c) => ({
  name: c.kind === 'org' ? 'organization' : 'project',
  path: c.addDir,
  kind: 'vault',
}));
s.brief = withVaultContexts(msg.brief, vaultCtxs);
```

Then:
- **Instructions, card shift** (line 1169-1170): render `mergeReadFolders(readFolders, vaultReadFolder)` instead of
  `readFolders`. The vault entries and the "knowledge vault is read-only … use aom commands" paragraph then appear under
  "Folders you can read". The ba_task and other branches stay as they are.
- **readDirs** (lines 1227-1231 and 1360-1364): unchanged expression. It already appends `...vaultReadFolder`, which is
  now non-empty for card shifts.
- **addDirs** (lines 1232 and 1359): `addDirs: scanDirs` (drop the `vaultCtx && msg.kind === 'card' ? [vaultCtx.addDir]`
  branch). The vault leaves `addDirs` and goes into `readDirs`. As a result, in every adapter:
  - Claude Code: still `--add-dir` (claude-code.ts:209 adds `readDirs` too). The sandbox opens it entry by entry
    (`sandboxReadEntries`, secret files left out), it is in `denyWrite`, and it gets `Edit(<vault>/**)` and
    `Read(<vault>/**/.env …)` deny rules (`readOnlyDenies`). This is the AC 3 behaviour, and it fixes the secret-file
    gap described in root cause 3.
  - Codex: `read` plus secret `deny` (codex.ts:250-257). Gemini and OpenCode merge `addDirs` and `readDirs` already.

Nothing else in the supervisor reads `vaultCtx`. `msg.vault` (writes in `aom publish`, the vault report and
transcripts) stays the single write target, unchanged.

### 6. Docs

- `docs/ARCHITECTURE.md` 16.1, third bullet: a card reads the organization vault (on Owner/Admin workstations) **and**
  its project's vault, read-only, both listed as read-only folders with secret files blocked. `ShiftStart.vaults` lists
  them, and `vault` stays the write target. Question, BA task, CEO and chat shifts still read one vault.
- `docs/RUNNER.md` around lines 1470-1474 ("the vault"): say "the vaults".

## Data model

No migration and no new event. The change is one additive optional protocol field and one server query function.

## Risks

- **Instruction size:** standing orders from two vaults. They are short files, and identical bodies are de-duplicated.
- **Sandbox scan cost:** `sandboxReadEntries` walks each vault (capped at 40,000 entries; over the cap the shell reads
  none of it, but the built-in Read/Grep/Glob tools still can). Question and BA task shifts already do this for the same
  vaults.
- **Same text for one-vault shifts:** titles stay unchanged with one context, and question, BA task and CEO shifts keep
  `[vault]`. Card shifts gain the "Folders you can read" vault lines and the "knowledge vault is read-only" paragraph.
  This is intended.
- **Mixed versions:** a new server with an old runner mounts `vault` only (as today). An old server with a new runner uses
  `[vault]`, now as a read-only folder (strictly tighter: secret files blocked).
- **Writes:** unchanged. `vault` keeps its value, so a vault report on a project with a git vault still goes to the
  project vault, and so on.

## Acceptance criteria mapped to the design

| AC | Design | Test |
|---|---|---|
| Server payload carries both vaults | `vaultsForCard` and `vaults` in `buildShiftStart` (3) | Server test S1 |
| Runner: both in read-only folders, sandbox read entries, instructions | `vaultReadFolder` for card shifts, `readDirs`, merged into "Folders you can read" (5) | Runner tests R1, R2 |
| Both read-only, writes refused, secret denies in both | the vault moves from `addDirs` to `readDirs`, so `denyWrite`, `Edit` denies and `secretReadDenies` apply (5) | Runner test R3; manual step 8 |
| No project vault: org only; no org vault: project only; no error | `all` filters what exists; the runner skips vaults without a clone (2, 4) | Server S2, S3; runner R4 |
| CEO, BA, question, chat, DevOps unchanged | `shiftVault`, `vaultForConversation` and those builders are not touched; the runner keeps `[vault]` for them | Server S4; runner R5; existing `chat-vault` tests |
| Root cause on the card | This report, section "Root cause" | n/a |
| Tests fail before, pass after; suites green | S1 fails today (no `vaults`), R1 fails today (no vault under "Folders you can read", vault in `addDirs`) | Full server and runner suites |

## Tests to write

Server (`apps/server/test/card-vaults.test.ts`, new; pattern from `architect-vault.test.ts` and `chat-vault.test.ts`:
`createWorld`, `w.connectRunner()`, `pipeline(w, r)`, `w.hire('Bo', 'builder', 'senior')`, `w.card(...)`, `p.next('Bo')`.
These tests need the `aom_test` Postgres database that the server suite already uses):
- **S1** Organization vault (`POST /api/vaults {kind:'org'}`) and a git project vault (`{kind:'project', projectId}`),
  owner's workstation: `start.vaults` has both ids (organization and project, primary first), and `start.vault` equals
  `vaultForProject` (the project vault).
- **S2** Project with no project vault: `vaults` = [organization vault], no error. Note: `ensureProjectVaultIn` may create
  a local project vault when `projectGraphs.enabled` is on (`AOM_PROJECT_GRAPHS`, default true). Delete it, or create
  the world with `env: { AOM_PROJECT_GRAPHS: 'false' }`.
- **S3** No organization vault, project vault only: `vaults` = [project vault].
- **S4** On the same world as S1, `buildQuestionShiftStart` / `buildBaTaskShiftStart` / the CEO start: `vault` equals
  `shiftVault(...)` and there is **no** `vaults` key. Also a Member's workstation: no organization vault in `vaults`.
- Unit-level: `vaultsForCard` with both, project-only, org-only, none, and a non-manager user.

Runner (`apps/runner/test/card-vaults.test.ts`, new; pattern from `architect-shift.test.ts`: `startHarness`,
`ScriptedAdapter` capturing the start input `i`, `vault.configure` with two vaults, or local vault folders under
`paths.vaults` with `.aom-local-vault` markers, see `vaults-local.test.ts`):
- **R1** `startExtra: { vault: P, vaults: [P, O] }`: `i.readDirs` contains both clone paths, `i.addDirs` contains
  neither, and `i.instructionsMarkdown` lists both under "# Folders you can read" with the vault paragraph.
- **R2** The standing orders of both vaults are in the instructions (root `standing-orders.md` of each, with the relabelled
  titles). PROJECT.md comes from the primary vault.
- **R3** Policy: `buildShiftSettings` (claude-policy.ts:633; `sandboxBlock` is internal) with `readDirs` holding both
  vault paths and `addDirs: []`: both paths are in `filesystem.denyWrite`, not in
  `allowWrite`, `permissions.deny` has `Edit(<vault>/**)` for both, `Read(<vault>/**/.env)` for both, and a `.env`
  placed in each vault is absent from `allowRead` (see `chat-vault.test.ts` "policy" case).
- **R4** `vaults` names a vault with no clone here: the shift starts with only the other one, and no error.
- **R5** Old shape: `{ vault: O }` and no `vaults`: the shift starts with that one vault mounted read-only. Question
  and BA task shifts with `vault` keep the vault folder as before (existing tests stay green).
- `readVaultContexts` / `withVaultContexts` unit tests: one context gives output identical to `withVaultContext`;
  duplicates are dropped.

Leave for testers: manual step 8 (a local runner, a builder shift on a GWP card: both vault folders readable, a direct
write into either refused).
