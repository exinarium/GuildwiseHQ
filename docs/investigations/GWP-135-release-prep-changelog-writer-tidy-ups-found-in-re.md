# Release prep changelog writer: five tidy-ups from the GWP-90 review

## 1. Question

The review of the 'Write changelog' step (GWP-90) left five non-blocking points:

1. a garbled usage line in `apps/runner/src/aom/aom-cli.ts`;
2. queued `release_changelog` tasks of release prep runs that already ended are still dispatched;
3. `deliverLater` sends the docs-prep step command after a fixed 250 ms timer, not after the commit;
4. the deny list rejects valid entries when an agent handle is also an ordinary word ('Mark items as done');
5. `checkChangelog` rejects a CHANGELOG.md whose version headings are all undated.

Before anything is built: which points are already fixed on `release/1.6.0`, and does guildwise-cloud's CHANGELOG.md
pass `checkChangelog`?

## 2. Step 0: fixed or open on release/1.6.0

The worktree HEAD (`6889a336`) is the tip of `origin/release/1.6.0` (same commit), so reading the worktree is reading the
branch.

| # | Status on release/1.6.0 | Where |
| --- | --- | --- |
| 1 | **Open, confirmed.** The usage text has the `report release-changelog` entry pasted into the middle of the `report spec-card` entry. Line 2869 reads `report spec-card --file <json>   report release-changelog --file <json> \| report release-changelog-fail --note "<why>"   BA release prep task: …`, and line 2870 starts with a bare `\| report spec-card-fail --note "<why>"   BA card task: …`. Introduced by 322e206f. | `apps/runner/src/aom/aom-cli.ts:2869-2870` (`USAGE`, line numbers moved from 2844) |
| 2 | **Open.** `baTaskPass` drops a stale `spec_card` task but has no check for `release_changelog`. `prepRepoOf` returns the run whatever its status, so `buildReleaseChangelogTask` builds a brief and a BA shift starts for a run that already passed, failed or was skipped. Only the report is then closed as cancelled. | `apps/server/src/dispatcher/ba-tasks.ts:78-108`, `apps/server/src/release/docs-prep-changelog-task.ts:65-75,93-98` |
| 3 | **Open.** `deliverLater` uses `setTimeout(…, 250)`. `db/tx.ts` has no after-commit hook. The release-prep task path has the same timer (`scheduleDelivery` in `docs-prep-tasks.ts:172-182`). | `docs-prep-changelog-task.ts:166-172` |
| 4 | **Open.** `changelogDenyList` puts agent names into the same flat list as member and workstation names. `scrubChangelogEntry` matches every term case-insensitively as a whole word, so the agent 'Mark' rejects 'Mark items as done from the board'. | `docs-prep-changelog-task.ts:39-62`, `packages/shared/src/release/changelog-entries.ts:85-92` |
| 5 | **Open.** `checkChangelog` reports an error for every undated version heading when the file has no dated heading at all (`newestDated < 0`). | `packages/shared/src/release/changelog-rewrite.ts:193-201` |

**None of the five is fixed. Build all five**, against the code as it is after GWP-134 merges (section 3).

## 3. The GWP-134 overlap: this card depends on it

GWP-134 ("one writer mechanism for the content steps") is in the same group and is **in build now**. Its design
(`docs/investigations/GWP-134-release-prep-one-writer-mechanism-for-the-content.md` on its branch, section 6) changes most
of the code this card was written against:

- it **deletes** `apps/server/src/release/docs-prep-changelog-task.ts`. `buildReleaseChangelogTask` moves to a new
  `docs-prep-writer.ts`, and `changelogDenyList` moves to `docs-prep-changelog.ts`;
- the changelog writer becomes a `release_prep` task of kind `changelog_entries` in `release_docs_prep_tasks`,
  dispatched by `releasePrepTaskPass`. `applyReleaseChangelogReport` and `runReleaseChangelogFallback` are replaced by
  `applyReleasePrepReport` and the generic failure model. A **legacy** branch stays for `release_changelog` BA tasks
  queued before the upgrade;
- it removes `report release-changelog` and `report release-changelog-fail` from the CLI and from `USAGE` line 2869;
- `checkChangelogProposal`, `scrubChangelogEntry` and `checkChangelog` (shared) are kept unchanged.

Building this card first would rewrite code that GWP-134 deletes, and the two branches would conflict in five files.
GWP-134's own report says this card "should check, against this branch once merged, which tidy-ups still apply".
**Decision: GWP-135 waits for GWP-134** (`aom block --on dependency GWP-134` is recorded). Every point still applies after
GWP-134. Only the place changes:

| # | After GWP-134 the fix goes into | If GWP-134 merged differently |
| --- | --- | --- |
| 1 | `USAGE`: the clean `report spec-card` line only. GWP-134 removes the release-changelog text, but if it only cuts that text out, the `spec-card` entry is still split over two lines | Both lines, as in 4.1 |
| 2 | `releasePrepTaskPass` (new path) **and** `baTaskPass` (legacy `release_changelog` tasks) | `baTaskPass` only |
| 3 | `afterCommit` in `db/tx.ts`, used by `docs-prep-tasks.ts` (`scheduleDelivery` goes) | The same hook, used by `deliverLater`'s callers |
| 4 | `changelogDenyList` (in `docs-prep-changelog.ts`) + shared `scrubChangelogEntry` / `checkChangelogProposal` | `changelogDenyList` in `docs-prep-changelog-task.ts` |
| 5 | shared `checkChangelog` (not touched by GWP-134) | the same |

Before you start, read the merged GWP-134 code and check every name below. Where GWP-134 landed differently from its
design, apply the same rule to the code that is there.

## 4. Findings, options and the design per point

### 4.1 Usage text (point 1)

What the command really accepts (`reportVerb`, `aom-cli.ts:455-515`): `spec-card` takes a JSON body (`--file`) and
`spec-card-fail` takes `--note`. `REPORT_USAGE` (line 444) is correct and does not change.

**Design.** Replace lines 2869-2870 of `USAGE` with one line per command pair:

```
  report spec-card --file <json> | report spec-card-fail --note "<why>"   BA card task: write the missing fields of a draft card so it can be specified (terminal)
```

and, **only if `report release-changelog` still exists in `reportVerb`** (that is, GWP-134 did not remove it):

```
  report release-changelog --file <json> | report release-changelog-fail --note "<why>"   BA release prep task: propose the public changelog entries for one repository (terminal)
```

No other line of `USAGE` changes.

**Test** (`apps/runner/test`, new or next to `aom-cli-question.test.ts`): `runAom(['--help'], ctx)` prints `USAGE`. Assert
that the spec-card line above is present, that no line of `USAGE` starts with `|`, and that `release-changelog` appears in
`USAGE` exactly when `reportVerb` accepts it (after GWP-134 it should not appear).

### 4.2 Stale queued tasks (point 2)

Prep run statuses (`2830_release_docs_prep.sql`): `running`, `passed`, `failed`, `skipped`. 'Skipped' is the owner's
Skip (`skipReleaseDocsPrep`), so for the card: finished = `passed`, failed = `failed`, cancelled = `skipped`.

Options:

- (a) close stale tasks when the run ends (in the projector or in `advance`/skip). This touches every way a run ends,
  including skip, and does not cover tasks that are already stuck;
- (b) **close them where they would be dispatched.** This is the pattern `baTaskPass` already uses for a `spec_card` of a
  cancelled card (`dispatcher/ba-tasks.ts:78-108`). It is small, it covers tasks that are already stuck, and it leaves
  other kinds alone.

**Recommendation: (b).**

**Shared helper** (server, next to the changelog code: `docs-prep-changelog.ts` after GWP-134):

```ts
const RUN_END: Record<string, string> = { passed: 'finished', failed: 'failed', skipped: 'was cancelled' };

/** Why a queued task of a release prep run must not start: the run ended (or is gone). Null while it is running. */
export async function prepRunEnded(db: Queryable, runId: string): Promise<string | null> {
  const run = await one(db, 'SELECT status FROM release_docs_prep_runs WHERE id=$1', [runId]);
  if (!run) return 'the release prep run ended (it no longer exists) before the task started';
  if (run.status === 'running') return null;
  return `the release prep run ended (it ${RUN_END[run.status] ?? run.status}) before the task started`;
}
```

**Legacy BA path, `baTaskPass`** (`dispatcher/ba-tasks.ts`, directly after the `spec_card` block and **before** the
fallback check, so a stale task is never given to `runBaTaskFallback` with "no BA was available"):

```ts
if (t.kind === 'release_changelog') {
  const why = await prepRunEnded(ctx.pool, t.prep_run_id);
  if (why) {
    await withAppendTx(ctx.pool, async (tx) => {
      const cur = await one(tx, `SELECT 1 FROM ba_tasks WHERE id=$1 AND status='queued' FOR UPDATE`, [t.id]);
      if (!cur) return;
      await ctx.store.append([/* BaTaskCompleted { taskId, status: 'cancelled', note: why } — same shape as the spec_card block */], { tx });
    });
    continue;
  }
}
```

Factor the append out of the `spec_card` block into a small `cancelQueued(ctx, t, note)` so the two blocks share it. A
task of a running run goes on unchanged (AC 4).

**New path, `releasePrepTaskPass`** (`docs-prep-tasks.ts`). The queued query joins `u.status = 'running'`, so tasks of
an ended run are silently left `queued` for ever. They are not dispatched, but they are not closed either. Add a
first step to the pass:

```sql
SELECT t.id, t.run_id FROM release_docs_prep_tasks t
  JOIN release_docs_prep_runs u ON u.id = t.run_id AND u.status <> 'running'
 WHERE t.status = 'queued'
```

For each row, in `withAppendTx`: re-read the task `FOR UPDATE` with `status='queued'`, then append
`taskFinished(run, id, false, why)` (`ReleaseDocsPrepTaskFinished`, `ok:false`, the note from `prepRunEnded`). Append the
event directly. Do not call `finishReleasePrepTask`, because the run is not running and no phase may finish. Add no
`code` (it is not a writer failure). The task table has no `cancelled` status (CHECK `queued|running|done|failed`), so
the task ends `failed` with the note. That is enough for the AC and needs no migration. The dispatch query for running
runs does not change.

**Risk to check in GWP-134's merged code:** a legacy `release_changelog` task of a **running** run. GWP-134 removes its
brief, so `buildBaTaskShiftStart` returns null after `BaTaskDispatched`. If GWP-134's legacy branch does not already
close such a task at dispatch, say so in the handoff (it is GWP-134's behaviour, not this card's AC). Do not change it
here.

**Tests (server, DB-backed, `ba-tasks.test.ts` / `release-docs-prep*.test.ts`):** one test per run status:

- legacy: two queued `release_changelog` tasks, one whose run is `passed` / `failed` / `skipped` (three cases) and one
  whose run is `running`. After `baTaskPass`, the ended one is `cancelled` with a note containing "release prep run
  ended", no `BaTaskDispatched` exists for it and no `shift.start` was sent. The running one is dispatched as before;
- new path: the same with `release_docs_prep_tasks` and `releasePrepTaskPass`. The ended one is `failed` with the note,
  and the running one is dispatched.

### 4.3 Deliver after commit (point 3)

Every caller of the changelog code runs inside `withTx`/`withAppendTx`: the report runs in `withInbox` (handlers.ts:218,
which is `withAppendTx`), the fallback and the dispatch in `withAppendTx` (dispatcher), and the tests in `withAppendTx`.
The report handler already delivers after the commit, but only to the **reporting** workstation
(`handlers.ts:352`). The prep command goes to the **repository's** workstation, which can be another one.

Options:

- (a) return the workstations to the caller (`ReportResult.deliverTo`, or a return value from `runBaTaskFallback`). This
  means changes through generic types for every task kind, and `ReportResult` is stored as JSON in `runner_inbox`;
- (b) **an after-commit hook on the transaction**, in `db/tx.ts`. One small, general mechanism, no plumbing, and it works
  for every caller. `schedule-actions.ts` already has an `after: [...]` list "after the transaction commits", but it is
  local to that module.

**Recommendation: (b).**

```ts
// db/tx.ts
const pendingAfterCommit = new WeakMap<pg.PoolClient, Array<() => unknown>>();

/** Runs fn once the transaction commits; never when it rolls back. Only inside withTx / withAppendTx. */
export function afterCommit(tx: Tx, fn: () => unknown): void {
  const list = pendingAfterCommit.get(tx);
  if (!list) throw new Error('afterCommit needs a transaction opened by withTx');
  list.push(fn);
}

export async function withTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const after: Array<() => unknown> = [];
  pendingAfterCommit.set(client, after);
  try {
    await client.query('BEGIN');
    const out = await fn(client as Tx);
    await client.query('COMMIT');
    pendingAfterCommit.delete(client);
    for (const f of after) void Promise.resolve().then(f).catch(() => undefined);
    return out;
  } catch (err) { /* ROLLBACK as today; the list is dropped */ throw err; }
  finally { pendingAfterCommit.delete(client); client.release(); }
}
```

The hooks are fire-and-forget, exactly as today's `deliverPending` calls. A hook error never changes the result of the
transaction.

Use:

- **after GWP-134:** in `docs-prep-tasks.ts`, `scheduleDelivery(ctx, ws)` becomes
  `for (const w of new Set(ws)) afterCommit(tx, () => ctx.services.gateway.deliverPending(w))`. Pass `tx` in. Delete
  `toDeliver`, `flushDelivery` and the `flushDelivery(ctx)` call at the top of `releasePrepTaskPass`. This is the path
  that sends the changelog `apply` command after the writer's report (`finishReleasePrepTask` → `afterTaskFinished` →
  `advance`);
- **if `docs-prep-changelog-task.ts` still exists:** `deliverLater(ctx, ws)` becomes `deliverAfterCommit(ctx, tx, ws)`
  with the same body, at its four call sites (`:213`, `:224`, `:251`, `:265`).

No new timer, delay or polling anywhere. Before you replace `scheduleDelivery`, grep every caller of the changed
function (`afterTaskFinished`, `finishReleasePrepTask`, `endReleasePrepShift`, `applyReleasePrepReport`, the reaper and
`handlers.ts:1233`) and confirm each runs inside `withTx`/`withAppendTx`. `afterCommit` throws otherwise, and that is the
point.

**Tests:**

- unit, pure, `apps/server/test/db-tx-after-commit.test.ts`: a fake `pool.connect()` client that records queries.
  (i) The hook runs after `COMMIT` (check the order of the recorded queries against the hook call). (ii) When `fn` throws,
  `ROLLBACK` runs and the hook never runs. (iii) `afterCommit` outside `withTx` throws. (iv) A throwing hook does not
  reject `withTx`.
- flow (DB-backed, `release-docs-prep-changelog-flow.test.ts`): with `vi.useFakeTimers()`, an accepted report and the
  fallback send `deliverPending` for the repository's workstation once `withAppendTx` has resolved, with
  `vi.getTimerCount() === 0` (no 250 ms timer). A report whose transaction is made to fail after the append (throw inside
  the `withAppendTx` callback after the call) sends nothing.

### 4.4 Deny list: agent handles that are ordinary words (point 4)

The match is made in shared `scrubChangelogEntry` (`changelog-entries.ts:85-92`): every term ≥ 3 characters, whole word,
case-insensitive. `@handle` is already refused separately as `not_public`, because `publicText` strips `@handles`. Agent
names are free text (the hire request), but the built-in pool (`commands/agents.ts:39`) is full of ordinary words:
Grace, Swift, Crane, Lark, Robin, Finch, Maple, Oak, Willow, Hazel, …

Options:

- (a) **position only**: a capitalised handle at the start of a sentence never counts. This weakens the check for every
  handle, because 'Katherine fixed the export' would pass;
- (b) **case only**: only the capitalised handle counts. This does not fix the example in the card, because
  'Mark items…' starts with a capital;
- (c) **an explicit list of handles that are ordinary words, and name-shaped matching for those only.** Every other
  handle, and every member, workstation and host name, is matched exactly as today.

**Recommendation: (c).** It is the only option that meets AC 6 without weakening anything else (constraint).

**Data.** `changelogDenyList` returns `{ terms: string[]; agentHandles: string[] }`:

- `terms` holds member display names, workstation names and host names, as today;
- `agentHandles` holds agent names (trimmed, length ≥ 3). A handle that is also a member, workstation or host name
  (case-insensitive) stays in `terms` only, so the strict match wins.

**Shared** (`changelog-entries.ts`):

```ts
/** Agent handles that are also ordinary English words: matched only where they are used as a name. Lower case. */
export const ORDINARY_WORD_HANDLES: ReadonlySet<string> = new Set([
  // the built-in name pool (commands/agents.ts)
  'grace','rob','swift','crane','lark','finch','robin','wren','heron','kestrel','osprey','plover','egret','merlin','tern',
  'ibis','sparrow','falcon','curlew','magpie','starling','alder','birch','cedar','elm','hazel','juniper','larch','maple',
  'oak','poplar','rowan','spruce','willow','yew','aspen','beech','cypress','hawthorn','linden','sycamore',
  // common given names that are words
  'mark','will','bill','joy','hope','faith','rose','may','june','april','august','summer','dawn','eve','amber','ruby',
  'pearl','ivy','lily','iris','daisy','holly','violet','olive','penny','sky','storm','river','brook','chase','drew',
  'hunter','guy','frank','art','jack','pat','sue','max','ray','gene','herb','wade','lance','miles','dean','rich',
  'sandy','cliff','dale','glen','grant','mason','carter','cash','page','reed','bell','price','don',
]);

const ROLE_WORD = '(?:agent|ba|architect|planner|builder|reviewer|tester|devops|ceo|scout|researcher|checker|curator|designer)';

/** Whether text uses an ordinary-word handle as a name: @Mark, Mark (BA), agent Mark, or a capitalised Mark mid-sentence. */
function namesAgent(text: string, masked: string, handle: string): boolean {
  const core = escapeRe(handle);
  const cap = escapeRe(handle[0]!.toUpperCase() + handle.slice(1));
  const isCap = (s: string) => /^[A-Z]/.test(s);
  if (new RegExp(`@${core}(?![A-Za-z0-9])`, 'i').test(text)) return true;                         // @Mark
  if (new RegExp(`${WORD_EDGE(core)}\\s*\\(\\s*(?:the\\s+)?${ROLE_WORD}\\b`, 'i').test(text)) return true; // Mark (BA)
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])${ROLE_WORD}\\s+(${core})(?![A-Za-z0-9])`, 'gi')))
    if (isCap(m[1]!)) return true;                                                                 // agent Mark, the BA Mark
  for (const m of masked.matchAll(new RegExp(WORD_EDGE(cap), 'g'))) {                              // case-sensitive
    const before = masked.slice(0, m.index).trimEnd();
    if (before !== '' && !/[.!?:;]$/.test(before)) return true;                                    // capitalised mid-sentence
  }
  return false;
}
```

`masked` is the existing `maskPublicTerms(text)`, so 'Runs on Swift 6' is not a name. Rule 3 requires the capitalised
handle, so 'the agent will now retry' passes.

`scrubChangelogEntry` gets an optional `agentHandles?: readonly string[]`:

- the strict set is `denyList` plus every handle that is **not** in `ORDINARY_WORD_HANDLES`, matched exactly as today;
- the loose set is the handles that **are** in the list, matched with `namesAgent`;
- either match gives the same single `{ code: 'deny_list' }` finding (never echoed, as today).

`checkChangelogProposal`'s context gets `agentHandles?` and passes it through. The server caller (after GWP-134:
`checkPrepProposal` in `applyReleasePrepReport`; before: `applyReleaseChangelogReport`) passes
`{ denyList: list.terms, agentHandles: list.agentHandles }`. Without `agentHandles`, behaviour is exactly as today, so
the existing tests and other callers are unchanged. `scrubGuideText` (user guide) is not touched.

Known residual false positive: an ordinary-word handle written capitalised mid-sentence as a UI label ('use the Mark as
done button'). The BA gets the finding in the same shift and rewords the entry. This is accepted, because the same
position is exactly where a real name sits ('a crash Will reported').

**Tests (shared, pure, `packages/shared/test/release-changelog-merge.test.ts` `scrubChangelogEntry` block, and
`release-changelog-task.test.ts`):** with `agentHandles: ['Mark']`:

- pass: 'Mark items as done from the board.'; 'You can mark items as done from the board.'; 'Saved views. Mark items as
  done from the board.';
- fail with `deny_list`: 'Mark (BA) added a filter to the board view.'; 'The agent Mark now retries the export.'; 'Fixed a
  crash that Mark reported in the export.'. '@Mark added a board filter today.' fails (both `not_public` and `deny_list`);
- with `agentHandles: ['Katherine']` (not an ordinary word), 'Katherine made the release flow faster.' still fails;
- `denyList: ['Mark']` (a member) still fails 'Mark items as done from the board.' (strict, unchanged);
- other terms unchanged: 'Fixed GWP-74 in the board.' still gives `ticket_key`, and a host name still gives `host_name`;
- server (DB-backed): `changelogDenyList` puts an agent name in `agentHandles`, and moves it to `terms` when a member has
  the same display name.

### 4.5 Undated version headings (point 5)

Why the check exists: `releaseChangelog` (Ship) returns `already` when `## [version]` exists, dated or not
(`releaseSectionOf`), and then uses that section, so the Unreleased entries are ignored. An undated heading is dangerous
only when it is the version being shipped. In practice that means an undated heading **above** the newest dated one (a
release section started by hand). In a file where every version is undated (releases recorded without dates), the
headings are history. Ship releases a new version and never matches them.

**Design** (`checkChangelog`, `changelog-rewrite.ts:193-201`):

1. Drop the `newestDated < 0 ||` part of the condition. An all-undated file passes. An undated heading **below** the
   newest dated one already passes today.
2. Keep the error for an undated heading **above** the newest dated heading (unchanged text). This is the Ship hazard
   above, and the case the code already flags. A mix with the dated releases on top passes.
3. New, so that step 1 does not open the hazard again: when `opts.version` is given and `## [opts.version]` exists
   **without** a date, push the existing "already has a ## [X] section without a date …" error for that heading. The
   dated case keeps its "already has a released" error.
4. No `## [Unreleased]`: the same error and text as now ("CHANGELOG.md has no ## [Unreleased] section."). This is the
   "no changelog structure" case.

The written format does not change: `releaseChangelog`, `newChangelog`, `composeReleaseSection` and `commitRelease` are
not touched, and `release-changelog-parity.test.ts` must still pass. `mergeUnreleased` calls `checkChangelog` (lines
344, 424), so it now also accepts all-undated files. That is intended.

Interpretation to state in the handoff: "a mix passes" is read as a mix whose newest version is dated (undated history
below it). A mix where an undated heading sits above the newest dated one keeps today's error, because that is the case
in which Ship would drop the Unreleased entries.

**Tests (shared, pure, new `packages/shared/test/release-check-changelog.test.ts`):**

- (a) Unreleased plus `## [1.2.0]`, `## [1.1.0]`, all undated: no errors;
- (a2) the same with `{ version: '1.3.0' }`: no errors. With `{ version: '1.2.0' }`: the undated error;
- (b) all dated: no errors;
- (c) mixed, dated on top and undated below: no errors;
- (c2) undated above dated: today's error (regression guard);
- (d) only `## [Unreleased]`: no errors;
- (e) `just some text`: exactly `['CHANGELOG.md has no ## [Unreleased] section.']`;
- (f) a fixture shaped like guildwise-cloud's file (below): no errors;
- `decideChangelogDispatch` (server, pure) with an all-undated changelog at the analysed head does **not** return `fail`;
- `changelogStep` (runner) on a worktree whose CHANGELOG.md is all undated writes the entries.

**guildwise-cloud's CHANGELOG.md** (read-only, at `origin/release/1.6.0` `c298514` and `origin/main` `d607331`, the same
file): `# Changelog`, an intro line, an empty `## [Unreleased]`, then `## [0.2.3] - 2026-11-05`, `## [0.2.2] - 2026-11-04`,
`## [0.2.1] - 2026-11-04`, `## [0.2.0] - 2026-11-04` and `## [0.1.0] - 2026-11-03`. Every version is dated, the file has no
corrupt characters and no bullets under Unreleased. **It passes `checkChangelog` today and after this change. No change
to guildwise-cloud is needed.** The planning note's concern does not apply to this file.

## 5. Files to change (after GWP-134)

| File | Change | Point |
| --- | --- | --- |
| `apps/runner/src/aom/aom-cli.ts` | `USAGE` spec-card line (and release-changelog line only if the command still exists) | 1 |
| `apps/server/src/dispatcher/ba-tasks.ts` | `release_changelog` stale check before the fallback; shared `cancelQueued` | 2 |
| `apps/server/src/release/docs-prep-tasks.ts` | close queued tasks of ended runs in `releasePrepTaskPass`; `scheduleDelivery` → `afterCommit` | 2, 3 |
| `apps/server/src/release/docs-prep-changelog.ts` | `prepRunEnded`; `changelogDenyList` returns `{ terms, agentHandles }` | 2, 4 |
| caller of `checkChangelogProposal` (`applyReleasePrepReport` / its helper) | pass `agentHandles` | 4 |
| `apps/server/src/db/tx.ts` | `afterCommit` + hook list in `withTx` | 3 |
| `packages/shared/src/release/changelog-entries.ts` | `ORDINARY_WORD_HANDLES`, `namesAgent`, `agentHandles` option | 4 |
| `packages/shared/src/release/changelog-task.ts` | `agentHandles?` in the `checkChangelogProposal` context | 4 |
| `packages/shared/src/release/changelog-rewrite.ts` | `checkChangelog` undated rule | 5 |
| tests as listed per point | | 2-5, 1 |

No migration, no event schema change and no change to guildwise-cloud.

## 6. Risks

- **Order.** If this card is built before GWP-134 merges, the builder rewrites deleted code. The dependency block
  prevents that. Check `aom card facts GWP-134` before you start.
- **`afterCommit` outside `withTx`.** It throws by design. Grep every path to the changed functions (section 4.3).
- **Deny-list word list.** It is curated, so a new built-in name that is a word must be added to it. Put a comment in
  `commands/agents.ts` next to `NAMES` pointing at `ORDINARY_WORD_HANDLES`.
- **Server tests need Postgres** (`test/helpers/db.ts`). The shared and runner tests are pure. If the server suites cannot
  run in the build sandbox, name them in the handoff for the testers: `ba-tasks`, `release-docs-prep*`,
  `release-prep-shift`, `release-changelog-parity`.
- The ledger notes one known failure in the shared suite ("release-changelog real CHANGELOG.md"). Check it once on the
  base commit and do not fix it here.

## 7. Acceptance criteria mapping

| AC | Met by | Test |
| --- | --- | --- |
| Step 0 recorded per point | Section 2 plus the card comment | n/a |
| Usage text correct, only real flags, nothing else changed | 4.1 | runner `--help` assertion |
| Ended run: no BA shift, closed with "prep run ended", no task | 4.2 `baTaskPass` (+ `releasePrepTaskPass`) | server, one case per passed/failed/skipped |
| Running run dispatched as before | 4.2, the check returns null and the code path is unchanged | the same tests, the running task |
| No fixed timer; send only after commit; nothing on rollback | 4.3 `afterCommit` | `db-tx-after-commit` unit + fake-timer flow test |
| Ordinary-word handle passes | 4.4 `namesAgent` | shared scrub tests |
| Real agent naming still rejected; other terms unchanged | 4.4 strict set + rules 1-4 | shared scrub tests + server deny-list test |
| `checkChangelog`: undated, dated and mix pass; no structure fails with the same reason | 4.5 | `release-check-changelog.test.ts` (a)-(e) |
| guildwise-cloud result recorded | 4.5: it passes | fixture (f) |
| Existing release-prep tests pass; new tests for points 2-5 | sections 4.2-4.5 | release-prep, BA-task and parity suites + typecheck |

## 8. Follow-ups (not in this card)

- `baseVersion` (`apps/server/src/release/proposal.ts:32`) reads only **dated** versions through `parseChangelog`. A
  repository with no tag and an all-undated CHANGELOG.md gets base version `0.0.0` in the Ship proposal. This was true
  before as well, but point 5 now lets such repositories through prep, so it becomes reachable.
- Member display names that are single ordinary words ('Will') are still matched strictly. Name-shaped matching could
  be extended to them if it ever causes false positives.
