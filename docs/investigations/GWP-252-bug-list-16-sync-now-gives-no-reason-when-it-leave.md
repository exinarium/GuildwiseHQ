# GWP-252: "Sync now" gives no reason when it leaves a branch alone

## 1. Question

When the working-branch sync (the "Sync now" button or the 10-minute periodic check) leaves the branch unchanged, the
user sees no reason and the runner logs nothing. The worst case is a working branch that is checked out in another
worktree: the result is `state: 'behind'` with a detail that does not name the worktree, nothing is logged, and the web
line only says "N commits behind origin". This report designs a machine-readable reason code plus a short message that
goes from the runner, through the server, to the web. It changes reporting only and does not change how syncing works.

## 2. Findings

### 2.1 Runner: `apps/runner/src/git/sync-branch.ts`

`syncWorkingBranchUnlocked` has these return paths. "Changed" means the local branch ref moved.

| # | Line | Condition | state | Changed | Detail today |
|---|------|-----------|-------|---------|--------------|
| 1 | 92 | `!isSafeGitRef(wb)` | error | no | `unsafe branch name "…"` |
| 2 | 93-94 | path missing or not a git dir | error | no | `no git clone at ${repoPath}` (**raw absolute path**) |
| 3 | 98 | `!hasRemote` | no_remote | no | none |
| 4 | 110 | origin ref missing | error | no | fetch error, or `origin has no branch X` |
| 5 | 111-112 | local branch missing | missing_branch | no | fetch error, if any |
| 6 | 129 | `behind === 0`, `ahead === 0` | synced | no | fetch error, if any |
| 7 | 129 | `behind === 0`, `ahead > 0` | ahead | no | fetch error, if any |
| 8 | 130 | ahead and behind | diverged | no | `X has N commit(s) origin does not have` |
| 9 | 132 | `input.readOnly` | dirty / behind | no | fetch error, if any |
| 10 | 136 | a card shift runs in one of this clone's worktrees | busy | no | `N card shift(s) are running…` |
| 11 | 145-149 | on branch, `merge --ff-only` refused over local changes | dirty | no | `uncommitted changes would be overwritten…` |
| 12 | 150 | on branch, ff failed for another reason | behind | no | first stderr line |
| 13 | 153-154 | **branch checked out in another worktree** | behind | no | `X is checked out in another worktree; it is left alone` (no path) |
| 14 | 164 | `update-ref` refused (ref moved meanwhile, lock) | behind | no | first stderr line |
| 15 | 168 | ff merge or update-ref succeeded | updated | **yes** | fetch error, if any |

`SyncService.sync` (`sync-service.ts`) adds two more results that do not change the branch:

| # | Condition | state | Detail today |
|---|-----------|-------|--------------|
| 16 | `findRepo` finds no local clone | error | `no local clone on this workstation` |
| 17 | an exception is thrown | error | the exception message (≤300 chars, **not masked**) |

`readOnly` is not passed by any caller today (`grep readOnly: true` finds only the pass-through in `sync-service.ts`).
It still gets a reason so that AC 3 holds for every path.

### 2.2 Logging

`SyncService` already has `this.log` (the runner `Logger`, wired with `log: this.log` in `runner.ts:570`). Today it is
used only for "could not save the sync targets". No sync outcome is logged. `createLogger` passes every line through
`redact()`, so secrets are masked, but paths are not.

### 2.3 Runner to server

The runner builds the `RepoSyncStatus` wire object **by hand in two places**, and each lists the fields one by one:

- `runner.ts:555-569`, the `send` dep of `SyncService` (`repo.sync_status`, after every sync);
- `runner.ts:2352-2367`, the `repo.sync` command result ("Sync now").

New fields would be lost if only one of these were updated. The design replaces both with one helper (§4.2).

`RepoSyncStatusSchema` (`packages/shared/src/protocol/runner.ts:1266`) is a plain `z.object`. Unknown keys are
stripped, so an older server ignores the new fields. `detail` is `.max(400)`, and a longer string makes `safeParse`
fail and **drops the whole status** (`applyRepoSyncStatus` returns silently). New text fields must be cut on the runner.

### 2.4 Server

- `applyRepoSyncStatus` (`apps/server/src/commands/repo-sync.ts:19`) upserts into `repo_sync_status` (migration
  `1860_repo_sync_status.sql`). There are no reason columns yet.
- `syncDto` (`apps/server/src/queries/misc.ts:519`) maps a row to the API for both the workstation list
  (`misc.ts:750`, `WorkstationDto.repos[].sync`) and the project page (`misc.ts:464`, `ProjectRepoDto.syncs[]`).
- `RepoSyncDtoSchema = RepoSyncStatusSchema.omit({ repoId })` (`packages/shared/src/api/workstations.ts:20`), and
  `ProjectRepoDto.syncs` extends it, so shared schema fields reach both API types automatically.
- Projection rebuild (`projections/rebuild.ts:82`) copies the table with `SELECT *`, so new columns are kept.

### 2.5 Web: `apps/web/src/components/RepoSync.tsx`

- `syncText` ignores `detail` for `behind` (so the checked-out-elsewhere text never appears), and it returns `null`
  for `no_remote` and `missing_branch`. In those cases `RepoSyncLine` renders **nothing at all**, which is the "looks as
  if nothing happened" symptom.
- `dirty` and `error` add `detail` to the state text.
- Badge tones are `success | warning | danger | neutral`.
- Existing web tests are in `apps/web/src/test/shift-stop-sync.test.tsx` (describe "working branch sync line").

### 2.6 Sandbox-safe path display

The helper that runner messages use is `displayDir(abs, home)` in `apps/runner/src/adapters/claude-accounts.ts:36`. Its
doc comment says: "A path inside the home as `~/x`, for display and the server (the real home path never leaves the
machine)". It is used for messages and server payloads in `login-accounts.ts`, `claude-account-provision.ts` and
`cli.ts`. (`toolchain/dotnet.ts` has an equivalent `shortPath`. `@aom/shared` `maskText` is the stronger sanitiser
used for `runner.error` platform diagnostics. It shortens every path to its last two segments, which would hide
which worktree is meant, so it does not fit here.)

`claude-accounts.ts` imports the credential store, auth and usage monitors. `git/` code should not import it. Move
`displayDir` (and `expandHome`, which sits next to it) into a small dependency-free module and re-export it from
`claude-accounts.ts`, so the existing importers do not change.

Clone paths outside the home (for example `/data/src/...`) stay absolute. That matches `displayDir` and the clone
`localPath` the server already stores and shows on the Workstations page. Only the home directory is masked.

## 3. Options

### 3.1 Where the reason lives

| Option | Pro | Con |
|---|---|---|
| A. Reuse `detail` only, with a better text | Smallest change | Not machine-readable, so the UI cannot pick a badge. Fails requirement 1 and AC 3 (a "reason code"). |
| **B. New optional `reason` (code) and `reasonMessage` (text), and keep `detail` as it is** | Machine-readable. Backward compatible both ways. Old servers and old web keep using `detail`. | Two text fields: the UI must not show both (handled in §4.5). |
| C. Replace `state` with a richer union | One field | Breaks every consumer and older runners. Rejected. |

**Chosen: B.**

### 3.2 Are `synced` and `ahead` skips?

The card conflicts with itself here. Requirement 1 lists "the branch is already current" as a skip that needs a reason,
and AC 3 says *every* path that returns without updating sets a reason. The planner's brief says synced/ahead are "not
skips". Resolution:

- The result **carries** a code on every path that does not update, including `up-to-date` (synced) and `local-ahead`
  (ahead). This satisfies AC 3 and requirement 1 literally.
- These two codes are **quiet**: the runner does not log them and the web shows no reason badge for them, because the
  state badge already says it ("in sync", "N commits ahead"). Without this, every repository would write a log line
  every 10 minutes, and the web would show "in sync" twice.
- The shared package exports `QUIET_REPO_SYNC_REASONS` and `isQuietRepoSyncReason(code)`, so the runner and the web use
  one rule.
- `updated` never carries a reason (AC 4).

### 3.3 Fetch failure

When `git fetch` fails, the measurement uses the stale `origin/<wb>`. The code is chosen like this:

- the specific skip code wins (diverged, busy, checked-out-elsewhere, …), and `detail` keeps the fetch error as it
  does today;
- when the result would be quiet (synced/ahead) or origin's ref is missing, the code is `fetch-failed`. Otherwise a
  failed fetch would show as a green "in sync" with nothing next to it. Today it does exactly that.
- `missing_branch` keeps `no-local-branch`, and the message adds the fetch error.

## 4. Design

### 4.1 Shared: `packages/shared/src/protocol/runner.ts`

```ts
/** Why a working-branch sync left the branch unchanged (GWP-252). Fixed set: the web maps each code. */
export const RepoSyncReasonSchema = z.enum([
  'unsafe-branch',          // 1  branch name is not a safe git ref
  'no-clone',               // 2, 16  no git clone at the path / none on this workstation
  'no-remote',              // 3  the clone has no origin
  'origin-missing-branch',  // 4  origin has no such branch
  'fetch-failed',           // 4/6/7 with a fetch error (see 3.3)
  'no-local-branch',        // 5  no local branch of that name
  'up-to-date',             // 6  quiet
  'local-ahead',            // 7  quiet
  'diverged',               // 8
  'read-only',              // 9  measured only
  'shift-running',          // 10 a card shift works in this clone
  'local-changes',          // 11 ff would overwrite uncommitted changes
  'fast-forward-failed',    // 12
  'checked-out-elsewhere',  // 13 the main case
  'ref-update-failed',      // 14
  'sync-failed',            // 17 unexpected exception
]);
export type RepoSyncReason = z.infer<typeof RepoSyncReasonSchema>;
export const QUIET_REPO_SYNC_REASONS: readonly RepoSyncReason[] = ['up-to-date', 'local-ahead'];
export const isQuietRepoSyncReason = (r: RepoSyncReason | undefined | null): boolean =>
  !!r && QUIET_REPO_SYNC_REASONS.includes(r);
/** Max length of `reasonMessage` (the runner cuts to this; a longer one would drop the whole status). */
export const REPO_SYNC_REASON_MESSAGE_MAX = 400;
```

In `RepoSyncStatusSchema`, add:

```ts
  /** Why the branch was left unchanged (absent: updated, or an older runner). An unknown code (newer runner) is dropped, not fatal. */
  reason: RepoSyncReasonSchema.optional().catch(undefined),
  /** Short human-readable reason, home masked as `~`. */
  reasonMessage: z.string().max(REPO_SYNC_REASON_MESSAGE_MAX).optional().catch(undefined),
```

`.catch(undefined)` matters for compatibility in the other direction: a later runner that adds a code must not make
this server's `safeParse` drop the whole status (zod ^4.6 is already used). The type stays
`RepoSyncReason | undefined`. Export the new names from the package index next to `RepoSyncStateSchema`.
`RepoSyncDto` and `ProjectRepoDto.syncs` pick up the fields through `omit`/`extend` with no edit.

Add a small map for the web fallback, used when a status has a code but no message:
`REPO_SYNC_REASON_TEXT: Record<RepoSyncReason, string>` (for example `'checked-out-elsewhere': 'checked out in
another worktree, so it was left alone'`). It can live in the same file or next to it.

### 4.2 Runner

**New light module** `apps/runner/src/home-path.ts` (name up to the builder). Move `displayDir` and `expandHome` here
from `adapters/claude-accounts.ts`, and re-export them from there (`export { displayDir, expandHome } from
'../home-path.ts'`). Add:

```ts
/** Every occurrence of the home folder in free text as `~` (only at a path boundary: `/home/u` must not eat `/home/user2`). */
export function maskHomeIn(text: string, home: string): string
```

Compare against `home` **and** `realpathSync(home)`, because `git worktree list` prints real paths and the home can be
a symlink. Escape the home for the RegExp, and match only when it is followed by `/`, `\`, end of text or a character
that cannot be part of a path.

**`sync-branch.ts`**

- `SyncResult`: add `reason?: RepoSyncReason; reasonMessage?: string;` (import the type from `@aom/shared`).
- `SyncInput`: add `home?: string` (default `homedir()`), so tests can check the masking.
- `worktrees()`: no change in behaviour. The checked-out-elsewhere path uses the matched entry:

```ts
const other = wts.find((w) => w.branch === wb);
if (other)
  return skip('behind', 'checked-out-elsewhere',
    `${wb} is checked out in another worktree (${displayDir(real(other.path), real(home))}); it was left alone. ` +
    `Update it there, or remove that worktree, then sync again`,
    `${wb} is checked out in another worktree; it is left alone`); // detail: unchanged text, for older web/servers
```

  (`find` can return the clone itself only when `onBranch` is true, and that case takes the other branch of the `if`.)
- Make one constructor for every non-updated return, so that no path can forget the reason:

```ts
const safe = (s: string) => maskHomeIn(maskSecrets(s), home).slice(0, REPO_SYNC_REASON_MESSAGE_MAX);
// before `counts` is known:
const early = (state, reason, message, detail?) =>
  ({ ...withCheckout, state, reason, reasonMessage: safe(message), ...(detail ? { detail: safe(detail) } : {}) });
// after: extend `out(state, detail?)` to `out(state, detail?, why?: { reason; message })`
```

  `maskSecrets` comes from `@aom/shared`. It removes credentials from URLs that git may print in fetch stderr. Apply
  `safe()` to `detail` too: path 2 puts the raw `repoPath` in `detail` today, which breaks AC 6 for the server-stored
  status. Also cut `detail` to 400 here, so the cut no longer depends on the two `runner.ts` call sites.
- Messages (short, plain; the builder may polish the wording, but each one must be non-empty):

| Path | reason | reasonMessage |
|---|---|---|
| 1 | unsafe-branch | `the working branch name "<wb>" is not a safe git branch name; nothing was changed` |
| 2 | no-clone | `no git clone at <displayDir(repoPath)>` |
| 3 | no-remote | `the clone has no origin remote, so there is nothing to sync from` |
| 4 | origin-missing-branch / fetch-failed | `origin has no branch <wb>` / `could not fetch <wb> from origin: <first line>` |
| 5 | no-local-branch | `there is no local branch <wb>; shifts start from origin, so nothing was changed` (+ `; the fetch also failed: …`) |
| 6 | up-to-date / fetch-failed | `<wb> is already up to date with origin` |
| 7 | local-ahead / fetch-failed | `<wb> has N commit(s) origin does not have; a sync never pushes` |
| 8 | diverged | `<wb> has N local commit(s) and M new on origin; it is never forced, so it was left alone` |
| 9 | read-only | `measured only; nothing was changed` |
| 10 | shift-running | `N card shift(s) are running in this repository; it catches up after they end` |
| 11 | local-changes | the existing dirty text (file list, "commit, stash or discard…") |
| 12 | fast-forward-failed | `fast-forward failed: <first line>` |
| 13 | checked-out-elsewhere | see above |
| 14 | ref-update-failed | `<wb> moved while it was being synced, or could not be updated: <first line>; it was left alone` |
| 15 | *(none)* | *(none)* |

- No change to which git commands run or in what order, nor to `withRepoLock` / `syncWorkingBranch`.

**`sync-service.ts`**

- `SyncStatusReport` gains the fields through `extends SyncResult`. No edit is needed there.
- The two inline error results (paths 16, 17) get `reason: 'no-clone'` and `reason: 'sync-failed'` with a message.
  Path 17's message goes through `maskHomeIn(maskSecrets(…))` too.
- After the result is known and before `send`, log once:

```ts
if (result.reason && !isQuietRepoSyncReason(result.reason))
  this.log.info(
    `working branch sync left ${t.workingBranch} unchanged in ${t.remoteUrlNormalized} ` +
    `(reason=${result.reason}): ${result.reasonMessage ?? ''}`,
    { repoId: t.repoId, state: result.state },
  );
```

  The line names the repository (normalized remote URL, which has no credentials, plus repoId), the branch, the code and
  the message, which holds the worktree path for AC 2. The level is info. Nothing is logged for `updated` or for quiet
  codes.
- Add and export `toRepoSyncStatus(r: SyncStatusReport): RepoSyncStatus`, which builds the wire object (all current
  fields plus `reason`/`reasonMessage` when set, text cut to 400). Use it in **both** `runner.ts` call sites
  (`send` at ~555 and the `repo.sync` result at ~2357) instead of the hand-written field lists.

### 4.3 Server

- **Migration** `apps/server/migrations/<next>_repo_sync_reason.sql` (next free number after main is merged; today
  the highest is 3000):

```sql
-- Why the last working-branch sync left the branch unchanged (null: it was updated, or an older runner).
ALTER TABLE repo_sync_status ADD COLUMN reason text, ADD COLUMN reason_message text;
```

  No backfill: existing rows get null, which means no reason, and the next check fills them.
- **`applyRepoSyncStatus`**: add `reason, reason_message` to the INSERT column list, the VALUES (`s.reason ?? null`,
  `s.reasonMessage ?? null`) and the `ON CONFLICT … DO UPDATE SET` (`reason=EXCLUDED.reason,
  reason_message=EXCLUDED.reason_message`). Because the upsert always writes them, a later status without a reason
  (an update, or an older runner) **clears** the stored one. The server must not trust the runner's masking alone: also
  run `reasonMessage` and `detail` through `maskSecrets` before storing. This is cheap and uses the same helper.
- **`syncDto`** (`queries/misc.ts:519`): add `...(r.reason ? { reason: r.reason } : {})` and
  `...(r.reason_message ? { reasonMessage: r.reason_message } : {})`. Both endpoints (workstations and project) use
  it, so there is nothing else to change. `requestRepoSync` and the routes are unchanged.

### 4.4 Web: `apps/web/src/components/RepoSync.tsx`

- `syncText`:
  - add cases `no_remote` (`${b}: the clone has no origin remote`, neutral) and `missing_branch` (`${b} has no
    local branch on this workstation`, neutral), so a skip is never invisible;
  - in `dirty` and `error`, add `s.detail` only when the status has **no** `reason` (older runner). With a reason, the
    second badge carries the explanation and nothing is shown twice.
- New exported `syncReason(s: RepoSyncDto): { text: string; tone: 'warning' | 'neutral' } | null`:
  - `null` when `!s.reason`, when `isQuietRepoSyncReason(s.reason)` or when `s.state === 'updated'` (a guard in case a
    stale value is left over);
  - text: `s.reasonMessage || REPO_SYNC_REASON_TEXT[s.reason]` (never empty, so there is no blank badge);
  - tone: `neutral` for `shift-running`, `read-only`, `no-remote`, `no-local-branch`; `warning` for the rest. It is
    **never** `danger`, so a skip looks different from an error badge and from the green success badge.
- `RepoSyncLine`: after the state badge, render
  `<Badge tone={r.tone} data-testid="repo-sync-reason">Left unchanged: {r.text}</Badge>` (or `title`/`aria-label`
  with the same text), and let it wrap (`break-all` on long paths; the line is already `flex-wrap`). The badge shows
  whatever the latest stored status says, so it stays until the next result replaces it and disappears when an update
  arrives (the server cleared the columns).
- `useSyncNow` is unchanged. `ProjectSettings.tsx` and `Workstations.tsx` (`WorkstationCard`) need no change, because
  both pass the DTO through.
- Touch devices: the badge is plain text in a wrapping flex row, so it needs no hover to read. Do not hide the message
  in a tooltip only.

### 4.5 Data model summary

| Layer | Field | Type |
|---|---|---|
| `SyncResult` / `SyncStatusReport` (runner) | `reason?`, `reasonMessage?` | `RepoSyncReason`, `string` |
| `RepoSyncStatus` (wire) | `reason?`, `reasonMessage?` | enum with `.catch(undefined)`, `string ≤400` |
| `repo_sync_status` (DB) | `reason`, `reason_message` | `text NULL` |
| `RepoSyncDto` / `ProjectRepoDto.syncs[]` (API) | `reason?`, `reasonMessage?` | through `omit` |

## 5. Acceptance criteria mapping

| AC | Design |
|---|---|
| 1. Message with the worktree path on Project settings and the workstation card | Path 13 → `checked-out-elsewhere` with `displayDir` path (§4.2); stored (§4.3); `syncReason` badge in `RepoSyncLine`, used by both pages (§4.4). |
| 2. One info log with repo, branch, code, path | Single `log.info` in `SyncService.sync` (§4.2). It runs once per sync, and "Sync now" calls `sync` once. |
| 3. Every non-updating path sets a code and message; a unit test for each | `early`/`out` constructors take a reason, and paths 1-14, 16, 17 are listed (§2.1, §4.2). Test per path (§6). |
| 4. An update has no reason; no leftover in the UI | Path 15 sets none; the upsert writes null and clears it; `syncReason` returns null (§4.3, §4.4). |
| 5. Optional fields; old runner accepted; no blank badge | `.optional().catch(undefined)`; null columns; badge only when `reason` is set, text falls back to the map (§4.1, §4.4). |
| 6. No masked path in the UI or stored status | `displayDir`/`maskHomeIn` + `maskSecrets` on runner `reasonMessage` and `detail` (fixes path 2's raw path), `maskSecrets` again on the server (§4.2, §4.3). |
| 7. Existing tests still pass | The existing `state` values and `detail` texts are unchanged (path 2's detail now shows `~`; the existing tests do not assert it). `syncText` output for the existing cases is unchanged when `reason` is absent. |

## 6. Tests

**Runner, `apps/runner/test/sync-branch.test.ts`** (existing `setup()`, `makeRepo`, `tmp`, `sh` helpers):

- checked-out-elsewhere: extend the existing "another worktree" case. Assert `reason === 'checked-out-elsewhere'`,
  that the tip is unchanged, and that `reasonMessage` contains the worktree path. Add a variant with
  `home: dirname(wt)` (real paths on both sides): the message contains `~/wt2` and not the absolute `wt`.
- One case per other path: unsafe name (`workingBranch: 'a..b'`), no clone (missing dir; also check the detail has no
  raw home when `home` is the parent), no remote (existing case + reason), origin missing branch (`workingBranch:
  'nope'` with an origin), fetch failed (point origin at a missing URL with `fetch: true` after one good fetch: code
  `fetch-failed`), no local branch (a branch only on origin), up-to-date and local-ahead (existing "synced and ahead"
  case + codes), diverged, read-only (`readOnly: true` while behind), shift-running (existing busy case),
  local-changes (existing overwrite case), and fast-forward-failed / ref-update-failed. These last two are hard to
  provoke with real git. Either use a locked ref (`refs/heads/work.lock` file present makes `update-ref` fail; for the
  on-branch ff, an `index.lock` file makes `merge` fail without the overwrite text), or skip the real-git case and
  state why in the handoff.
- Update cases (existing "moves the ref" and "fast-forwards"): assert `reason` and `reasonMessage` are `undefined`.
- **Logger**, in a new `describe('SyncService')` (in this file or `sync-service.test.ts`): a fake `Logger` with spies,
  `findRepo` returning the temp clone, `send` collecting. A checked-out-elsewhere sync gives exactly one `info` call
  that contains the remote, the branch, `checked-out-elsewhere` and the path, and no `warn`/`error`. An updating sync
  gives no `info`. A synced (quiet) sync gives no `info`. Also assert `toRepoSyncStatus` carries the reason and passes
  `RepoSyncStatusSchema.parse`.

**Shared** (`packages/shared/test/…`): a status without reason fields parses (old runner); a status with an unknown
`reason: 'future-code'` parses with `reason` undefined; a `reasonMessage` over 400 fails (this documents why the runner
cuts it).

**Server, `apps/server/test/shift-stop-sync.test.ts`** ("stores the runner report" block, which needs the DB test
setup; if Postgres is not available in the build sandbox, name it for the testers): send `status({ state: 'behind',
reason: 'checked-out-elsewhere', reasonMessage: '… (~/wt) …' })`. The row and both APIs return the reason and message.
A second status without reason fields leaves the row and API with no reason (this covers both the clearing and the
old-runner case).

**Web, `apps/web/src/test/shift-stop-sync.test.tsx`** ("working branch sync line"): a status with a reason renders
`repo-sync-reason` with the message and a non-danger tone (check the badge class or `data-tone`, whatever `Badge`
exposes). A status without a reason renders no `repo-sync-reason`. `updated` with a stale reason renders none. A quiet
code renders none. `no_remote` now renders a line. A status with a code and no message renders the fallback text.

Run only the unit suites with the Boundaries' timeouts.

**Manual** (owner, on a workstation; `git worktree add` cannot run in the sandbox): `git worktree add <path>
<working-branch>`, then "Sync now" on Project settings: the badge with `~/…` path shows there and on the workstation
card, and `logs/runner.log` has one INFO line. `git worktree remove <path>`, then "Sync now": the branch updates and
the badge is gone.

## 7. Risks

- **Whole-status drop on length**: a message over 400 characters would make the server discard the status. Mitigated by
  cutting in `safe()` and in `toRepoSyncStatus`, plus a shared test.
- **Forward compatibility of the enum**: mitigated by `.catch(undefined)`. Without it, the next added code would be
  dropped silently by servers built from this version.
- **Log volume**: `shift-running` (and any persistent skip such as `checked-out-elsewhere`) logs one INFO line per
  10-minute check per repository. This is acceptable and is what requirement 2 asks for. Quiet codes are not logged.
- **Moving `displayDir`**: the re-export keeps every importer compiling. Run the runner type-check.
- **Two runner call sites**: one helper (`toRepoSyncStatus`) removes the drift risk. Do not add the fields inline in
  `runner.ts`.
- **Migration**: an additive, nullable column on operational (non-projection) data. Rebuild copies `SELECT *`.
- Size: about 250-350 changed lines across shared, runner, server (migration) and web, plus tests.

## 8. Out of scope

`VaultManager.syncNow` (vault sync). Any change to when or how a branch is moved. Showing a history of skips (only the
latest status is kept, as today).
