# GWP-106: devops AC4 "vault isolation" fails in the full E2E run on release/1.5.0

Base commit: `caa6a44f` (the worktree HEAD and `release/1.5.0` are the same commit).

## 1. The question

`e2e/tests/devops.spec.ts` test *"AC4: a card shift reads the organization vault's standing orders and its project's
own vault, never another project's documents"* (line 512) fails in the full suite run of GWP-99 on release/1.5.0.
Is it a harness defect (state left by other specs, order dependence, timing) or a product defect (a card shift can see
a vault outside its scope)? Fix it where it sits without loosening the isolation checks.

## 2. The run log

DevOps posted the GWP-99 full-run log (release/1.5.0, `/home/exinarium/devbox-cache/gwp99-run/run.log`) on the card.
The AC4 failure in it:

```
[devops] tests/devops.spec.ts:512 AC4 (30.3s)
Error: timed out waiting for both vaults cloned; last: 3
    at waitFor (e2e/support/db.ts:41)
    at tests/devops.spec.ts:527
```

So the test fails **in the `'both vaults cloned'` wait itself** (l.527), not at the l.600 assertion that this report
first predicted. The duration (30.3 s) is the wait's 30 s timeout. The wait asks for a count of exactly 2. It saw 3,
so rows that do not belong to this test were counted. Section 3.4 explains why that makes the wait time out.

## 3. Findings

### 3.1 What AC4 actually checks

Despite the spec file's name, AC4 does not involve the DevOps engineer. It checks the **card-shift vault scope**
under the `E2E DevOps` user's own organization (`inviteAndAccept` runs `admin:create`, so DEVOPS is the Owner of an
organization of its own, separate from ADMIN's):

| Agent | Project | Vaults the server gives its card shift (`vaultsForCard`) | Expected in its `CLAUDE.md` |
|---|---|---|---|
| Dana (hired in `setup`) | DVO, folder `projects/dvo` | org vault WORK (primary; the workstation user is Owner) | `WORK-MARK`, `WORK-ORDER`, **not** `PERSONAL-MARK` |
| Hal (hired in AC4) | HOB, folder `projects/hob` | HOB project vault PERSONAL (primary) + org vault WORK | `PERSONAL-MARK`, `WORK-ORDER`, **not** `WORK-MARK` |

### 3.2 The product is correct for this scenario

- `apps/server/src/commands/vaults.ts` `vaultForProject` (l.476) picks the project's own git vault, else the org vault
  (Owner/Admin workstations only). `vaultsForCard` (l.515) adds the org vault for managers and the project's own vault.
  Both are keyed on the card's `projectId` and its `org_id`. A DVO card never gets HOB's vault, and every vault gets
  the card project's folder (`projects/hob` for HOB), so the org vault's `projects/dvo/PROJECT.md` (`WORK-MARK`) is
  never read for HOB.
- `apps/runner/src/vaults/context.ts` `readVaultContext` reads only `<vaultsDir>/<vaultId>` (confined) and only
  `standing-orders.md`, `<folder>/standing-orders.md` and `<folder>/PROJECT.md`. **A vault with no clone yet is
  skipped without an error** (`No clone yet: no vault context`). That is the behaviour the race in 3.4 depends on.
- `apps/runner/src/adapters/read-only-dirs.ts` `sandboxReadEntries` only splits one folder into entries that are not
  secret. It does not choose which vaults a shift gets, so it is not involved.
- `GET /api/agents` is org-scoped (`requireOrg` and `listAgents(..., a.orgId, ...)`), and only devops.spec hires in
  the DEVOPS org. The planning suspicion that "another spec's Dana is picked" is **refuted**.
- No other spec uses the project keys `DVO` or `HOB`, so `SELECT stage FROM cards WHERE ref=$1` is not ambiguous.

### 3.3 The harness defect: the "both vaults cloned" wait reads the whole database

```ts
// e2e/tests/devops.spec.ts l.527-539
await waitFor('both vaults cloned', async () =>
  existsSync(join(HOME, 'vaults')) &&
  (await q(`SELECT count(*)::int AS n FROM workstation_vaults wv JOIN vaults v ON v.id = wv.vault_id
            WHERE wv.local_path IS NOT NULL AND v.storage = 'git'`))[0]?.n,
  (n) => n === 2, 30_000);
```

The query is not filtered by workstation, organization or vault id. It counts every git vault cloned on **any**
workstation in the run's database. `workstation_vaults` rows stay after their spec ends (the upserts in
`commands/vaults.ts markVaultStatus` l.716 and `runner-gateway/handlers.ts recordVaults` l.1178 never delete), and
there is no `DELETE /api/vaults`.

**Which spec leaks the row:** `e2e/playwright.config.ts` runs with one worker. Projects run in dependency layers:
`storage` depends only on `auth`, while `devops` depends on `auth → pairing → core-loop → desk → chat`, so in a full
run `storage` always runs **before** `devops`. `storage.spec.ts` test *"vault: a folder in the organization vault
connects..."* (l.433, added 2026-11-04 in `688930c0`, the same day as the GWP-99 run) registers a git org vault
(`makeVault('storage')`) and waits until its own runner has cloned it. That leaves one git `workstation_vaults` row
with `local_path` set, on the storage spec's workstation. No other spec that runs before devops leaves such a row:
`business-terms` registers git vaults but pairs no runner, and the rest register no vault. When devops runs alone
(`--project=devops`), only auth, pairing, core-loop, desk and chat run first, so the count is exact and AC4 passes.
That explains why it fails only in the full run.

`makeVault` (`e2e/support/vault.ts`) is **not** at fault. Each spec uses its own fixture name (`org` and `hob` are
used only by devops.spec; `guide-screenshots` also uses `org`, but only in the separate `AOM_E2E_GUIDE=1` run), and
global setup wipes `E2E_DIR` and drops the database at the start of each run. `db.ts` `q`/`waitFor` are neutral
helpers. The defect is the unscoped SQL in the spec.

### 3.4 How the leak breaks AC4

When AC4 starts, Dev Box already has the WORK clone from AC2 (1 row). Rows left by earlier specs add to that count.
The wait asks for `n === 2` exactly, so the test breaks in one of two ways, depending on how many rows were left:

- **Two or more stray rows (what GWP-99 shows).** The count is above 2 before the HOB vault is cloned and climbs
  further once it is. It never equals 2, so the wait times out: `timed out waiting for both vaults cloned; last: 3`.
  This is the failure in the log.
- **Exactly one stray row** (storage.spec's org vault alone). The count is already 2 before the HOB vault is cloned,
  so the wait returns at once. If Hal's shift then starts before the HOB clone (`readVaultContext` skips a vault with
  no clone, without an error), the test fails at l.600 (`PERSONAL-MARK`) instead.

storage.spec's `Firm vault` (l.434-436, its own `Office PC` runner) is one stray row that the code shows. The code
alone does not show where the other one came from in GWP-99. The candidates are another spec that runs before
devops, or more than one row left by a spec that does. Whichever spec left it, the cause is the same: the wait counts
rows from the whole database. The fix in section 4.1 works whatever earlier specs leave, because it reads only this
test's two vault ids on Dev Box.

### 3.5 Verdict

**Test-harness defect** (order dependence through an unscoped DB read). This is not a product defect: no shift was
shown a vault outside its scope, and the scoping code is correct for the scenario. Card AC5 (product unit test)
therefore does not apply.

## 4. Options

| Option | What | Verdict |
|---|---|---|
| A. Scope the wait to this test's vaults on Dev Box, and wait for the clone contents on disk | Read the WORK and HOB vault ids; wait until both `workstation_vaults` rows for `workstationId` have `local_path` **and** both clones hold their seed files | **Recommended.** Removes the order dependence and the race. Changes nothing that is shared. |
| B. Make storage.spec delete its vault at the end | No delete API exists; it would need a product change or raw SQL deletes behind the server's back | Rejected: it fixes one leaker, not the reader, and the next spec that clones a vault breaks AC4 again. |
| C. Change `count === 2` to `>= 2` | | Rejected: it keeps the race (it can pass before HOB is cloned) and hides the defect. |
| D. Retry, or a longer timeout | | Forbidden by the card. It also does not help, because the wait passes too early rather than timing out. |

### 4.1 Recommended design (option A)

All in `e2e/tests/devops.spec.ts`. No shared helper changes are needed.

1. In AC4, capture the vault ids:
   ```ts
   const hobVaultId = (await hobVault.json()).id as string;      // POST /api/vaults returns the vault object (routes/vaults.ts l.29-34)
   const workVaultId = (await q<{ id: string }>(
     `SELECT id FROM vaults WHERE kind='org' AND org_id = (SELECT org_id FROM projects WHERE id=$1)`, [projectId],
   ))[0]?.id as string;                                          // same lookup as workClone()
   ```
2. Replace the `'both vaults cloned'` wait with one scoped to this workstation and these two vaults, and require the
   clone contents the assertions depend on:
   ```ts
   await waitFor(
     'the organization and HOB vaults are cloned on Dev Box',
     async () => {
       const rows = await q<{ vault_id: string }>(
         `SELECT vault_id FROM workstation_vaults
           WHERE workstation_id = $1 AND vault_id = ANY($2::uuid[]) AND local_path IS NOT NULL`,
         [workstationId, [workVaultId, hobVaultId]],
       );
       return rows.length === 2 &&
         existsSync(join(HOME, 'vaults', workVaultId, 'standing-orders.md')) &&
         existsSync(join(HOME, 'vaults', hobVaultId, 'projects', 'hob', 'PROJECT.md'));
     },
     (ok) => ok,
     30_000,
   );
   ```
   Keep the comment about the automatic local folders not being clones. The workstation and vault-id filter makes
   `v.storage='git'` unnecessary.
3. Make the Dana lookup use the id from `setup`. Store `danaId` from the hire response at l.126-137, as AC4 does
   for Hal, and use `instructions(danaId)`. The name lookup is not the cause (it is org-scoped), but this removes the
   last lookup by name.
4. **Keep every isolation assertion exactly as it is** (l.594-603): `- Key: DVO/HOB`, `WORK-MARK` in Dana / not in
   Hal, `PERSONAL-MARK` in Hal / not in Dana, `WORK-ORDER` in both. Optional, and only if it holds in a run: also
   assert on the listed read folders. The instructions list each vault as `- <path> (the knowledge vault ...)`
   (`packages/shared/src/prompt/readable.ts` l.26). Assert that Dana's file does not contain
   `join(HOME, 'vaults', hobVaultId)`, and add the positive control that Hal's file does. This covers the card's
   "cannot list a vault outside its scope". Add the negative check only together with the positive control, so it
   cannot pass for the wrong reason.
5. Cleanup: the test's data already lives in the DEVOPS user's own organization with fixture names that no other
   spec uses, and global setup drops the database and `E2E_DIR` at the start of each run. There is no vault delete
   API, and no later spec reads DEVOPS, HOB or Hal state. No further cleanup is needed. Do not add raw SQL deletes:
   they would bypass the server's projections.

### 4.2 Not in scope (recorded as a backlog suggestion)

Seven sibling specs that run **after** devops have the same unscoped pattern:
`SELECT local_path FROM workstation_vaults` with `r[0]?.local_path` in architect l.133, interests l.129,
interests-migration l.72, project-convert l.112, ranking l.179 and research l.118 (guide-screenshots l.307 runs only
in the guide run). Because devops already leaves rows, these waits pass at once without waiting for their own clone.
They are latent races, not failures in GWP-99. devops.spec also has unscoped event and desk counts
(`DevOpsApprovalNeeded`, `AgentReset`, `desk_items subkind='devops'/'vault_conflict'`) that would break if a spec
before it produced those rows. This card changes none of them, so card AC6 is safe.

### 4.3 How to reproduce and what the log should show

- Reproduce on the base commit: `pnpm -C e2e exec playwright test --project=storage --project=devops`. Storage runs
  first (layer 2), so AC4 sees the leaked row. `--project=devops` alone passes.
- The GWP-99 log shows `timed out waiting for both vaults cloned; last: 3` (db.ts:41, from devops.spec.ts:527): the
  form with more than one stray row (section 3.4). A run with exactly one stray row would fail at l.600 instead.
  Option A fixes both forms.
- architect.spec cannot run before devops through `--project` (it depends on `intake → research → sharing →
  devops`). To show "after architect", run `--project=devops` once after a full run of the projects up to architect
  in the same database, or record that the config order makes architect-before-devops impossible. storage is the
  spec that matters.

## 5. Mapping to the card's acceptance criteria

| Card AC | How it is met |
|---|---|
| AC1 root cause recorded, quoting the log, harness vs product | Section 3 (harness defect). The quote from the log must be pasted on the card by whoever gets the log from DevOps (section 4.3 has the expected text). |
| AC2 passes alone and in the full run on release/1.5.0 | The scoped wait in 4.1 (2). DevOps runs `--project=devops` 3×, `--project=storage --project=devops`, and the full suite. |
| AC3 isolation still asserted, nothing skipped or loosened | 4.1 (4): the assertions are unchanged (optionally extended with a read-folder check plus its positive control). No skip, no retry, no timeout change. |
| AC4 own data, unique ids, cleanup, order-independent | Own org, own fixtures, the wait reads only this test's vault ids on this workstation, Dana by id. Cleanup in 4.1 (5). Shown by the storage→devops run. |
| AC5 product unit test | Not applicable: not a product defect (3.2). |
| AC6 no other vault.ts/db.ts spec breaks | No shared helper changes. Only devops.spec.ts changes. The full run confirms it. |

## 6. Routing, risks and coordination

- **Every change is under `e2e/**`.** The CEO's standing ruling (ledger aadf93f9, 69b39b28, f87e3c86 for GWP-103)
  is that builders get no exception to the e2e guard. The build stage of this card should go to a **tester-role
  shift**, as GWP-103 did, and DevOps runs the E2E suites (standing order).
- Risk: `local_path` can be recorded before the clone has its files (AC2's comment says so). That is why the wait
  also checks the seed files on disk.
- Coordination: GWP-103 (`tester-e2e-env`) edits `e2e/support/*`. This design does not touch them, so there is no
  conflict. GWP-105 is in the same group and also touches only its own spec.

## 7. Reference change for `e2e/tests/devops.spec.ts`

The spec is owned by the tester role, so the change is written out here to apply as it stands. Checked against the
base commit: `POST /api/vaults` returns the vault object (`apps/server/src/routes/vaults.ts`, `return one(whoOf(a), id)`)
and `POST /api/agents` returns the agent object (`apps/server/src/routes/agents.ts`, `return one(a.session.user.id, id)`),
so both have `.id` at the top level, as `halId` already relies on.

### 7.1 Store Dana's id at hire (`setup`, l.24-27 and l.126-136)

```ts
// with the other module-level lets
let danaId: string;
```

```ts
  expect(hire.status(), await hire.text()).toBe(201);
  danaId = (await hire.json()).id as string;
```

### 7.2 Capture the two vault ids (AC4, after l.521)

```ts
  expect(hobVault.status(), await hobVault.text()).toBe(201);
  const hobVaultId = (await hobVault.json()).id as string;
  // the organization vault registered in AC2 (the same lookup as workClone)
  const workVaultId = (
    await q<{ id: string }>(
      `SELECT id FROM vaults WHERE kind='org' AND org_id = (SELECT org_id FROM projects WHERE id=$1)`,
      [projectId],
    )
  )[0]?.id as string;
  expect(workVaultId).toBeTruthy();
```

### 7.3 Replace the `'both vaults cloned'` wait (l.526-539)

```ts
  // this test's two repository vaults are cloned on Dev Box, with their files on disk. The wait reads only these two
  // vaults on this workstation: rows other specs leave in workstation_vaults (storage.spec runs first in a full run)
  // must not satisfy it. local_path is recorded before the clone has its files, so the seed files are checked too.
  // (The projects' automatic local folders are not clones.)
  await waitFor(
    'the organization and HOB vaults are cloned on Dev Box',
    async () => {
      const rows = await q<{ vault_id: string }>(
        `SELECT vault_id FROM workstation_vaults
          WHERE workstation_id = $1 AND vault_id = ANY($2::uuid[]) AND local_path IS NOT NULL`,
        [workstationId, [workVaultId, hobVaultId]],
      );
      return (
        rows.length === 2 &&
        existsSync(join(HOME, 'vaults', workVaultId, 'standing-orders.md')) &&
        existsSync(join(HOME, 'vaults', hobVaultId, 'projects', 'hob', 'PROJECT.md'))
      );
    },
    (ok) => ok,
    30_000,
  );
```

`workstation_vaults.workstation_id` and `vault_id` are both `uuid` (`apps/server/migrations/0300_vaults.sql` l.18-20),
so `$2::uuid[]` matches the column type.

### 7.4 Read Dana by id (l.575-577 and l.593)

Delete the `const dana = ... .find((a) => a.name === 'Dana')` lookup and use:

```ts
  const w = instructions(danaId);
```

### 7.5 Assertions

Lines 594-603 stay exactly as they are. Optional addition, only together with its positive control, and only if a run
shows the read list in this form (`packages/shared/src/prompt/readable.ts` l.26):

```ts
  expect(h).toContain(join(HOME, 'vaults', hobVaultId)); // positive control: Hal is given the HOB vault folder
  expect(w).not.toContain(join(HOME, 'vaults', hobVaultId)); // Dana is not
```

No skip, no retry, no timeout change, no `>= 2` count, no change under `e2e/support/`, no product change.

### 7.6 Runs (DevOps, per standing order)

1. `pnpm -C e2e exec playwright test --project=devops` three times: green.
2. `pnpm -C e2e exec playwright test --project=storage --project=devops`: green with the change. On the base commit
   it can fail (early pass, then l.600) or pass by luck, because storage alone leaves one stray row (section 3.4).
   The full run is the one that reproduces the GWP-99 timeout.
3. The full suite on release/1.5.0: AC4 green, no new failures compared with the GWP-99 run.
