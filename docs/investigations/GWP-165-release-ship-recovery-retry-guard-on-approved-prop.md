# Release ship recovery: Retry guard, stuck ship, kept ref cleanup

## 1. Question

Three follow-ups to the release ship flow (desk item "Ship release", `apps/server/src/release/ship.ts`,
`apps/runner/src/git/release-ship.ts`):

- **R1** Retry must be accepted only when the ship is `failed` and the release proposal is still `approved`.
- **R2** A ship left in `committing` (runner lost mid-step) must be recoverable with Retry and Dismiss. Retry must not be
  offered while the runner is still working on it.
- **R3** Dismiss must remove the kept ref `refs/guildwise/release/<version>` on the workstation(s).

Before planning, record which of these were already on `release/1.6.0`.

## 2. State of `release/1.6.0` before this work

The card branch is at `9288c422`. That is exactly `origin/release/1.6.0` (no diff in any release ship file).

| Item | State | Evidence |
|---|---|---|
| R1 | **Not done** | `retryReleaseShipIn` (`ship.ts:195`) checks only `ship.status !== 'failed'`. `closeItem` (`commands/desk.ts:334-340`) lets Retry through on a **closed** `release_failed` alert (`retryClosedAlert`). So Dismiss → Retry on the same alert re-queues `release.ship` for a dismissed proposal. Confirmed. |
| R2 | **Not done** | Nothing detects a stuck `committing` ship. A `committing` ship has no open desk item: the `ship_release` approval is resolved, and the `release_failed` alert only exists after `ReleaseFailed`. The repository row only says "preparing the release commit…" (`WorkingBranchControl.tsx:281`). |
| R3 | **Partly done** | The runner deletes the kept ref after a successful push (`release-ship.ts:325`) and when the branch moved (`:148`). A failed push keeps it on purpose (that is how Retry resumes). `dismissReleaseShipIn` (`ship.ts:254`) queues nothing, and no runner command can delete the ref. |

Since not all three are done, the card is built. R1 and R2 are built in full, and R3 for the Dismiss path.

## 3. Findings that shape the design

1. **Delivery of runner commands.** `release.ship` is a durable `runner_commands` row (`pending` → `sent` → `done`/`failed`).
   On every reconnect `requeueSentCommands` (`commands-queue.ts:57`) puts `sent` back to `pending`, so a runner that
   restarts mid-ship gets the command **again** and re-runs it. The ship run is idempotent:
   - Step 2: if the branch already has the version section, the answer is `alreadyDone` with the existing commit.
   - Step 3: if the commit was made but not pushed (the kept ref, parent == tip), that commit is pushed.
   - The tag check refuses a version whose tag exists.

   So a plain restart already recovers by itself. A ship is only truly stuck when its command will **never** produce an
   applied result.
2. **How a ship gets stuck** (the command is no longer live, or will never be delivered):
   - a. The result arrived, `completeCommand(done)` ran (`handlers.ts:606`), then `applyReleaseShipResult` threw. The
     command is `done`, the ship stays `committing`, and a second answer is dropped (`status === 'done'` → ack).
   - b. The command is `failed` (attempt limit) or the row is missing.
   - c. The ship's workstation was removed or deactivated (`status <> 'active'`), so a `pending` command is never delivered.
   - d. The workstation went offline mid-step and never came back.
3. **Older runners drop unknown commands silently.** The runner parses server frames with
   `ServerToRunnerSchema.safeParse` (`connection/client.ts:218`). A `command` frame whose name is not in its
   `RunnerCommandNameSchema` enum fails to parse and is **dropped** with a warning: no crash, but also no answer. Without
   a guard the row would stay `sent` and be requeued forever. Every recent command is therefore gated on a capability the
   runner announces in `hello` (`runner.ts:1468`, stored in `workstation_capabilities`), as `release-ship:1` and
   `release-publish:1` are. The new command must follow the same pattern.
4. **The desk already renders Retry and Dismiss** for `release_failed` alerts (`Desk.tsx:1089`, covered in
   `apps/web/src/test/desk.test.tsx:270-293`). The project page shows Retry for a stopped publish step (`ReleaseStatus`).
5. **`git update-ref -d` of a missing ref exits 0** (checked with git 2.53 in a scratch repo). The runner still checks
   with `revParse` first, so older git versions behave the same.
6. **Gap in the runner:** if the runner is lost **after** the push but **before** `update-ref -d` (`release-ship.ts:325`),
   the re-run takes the `alreadyDone` path (step 2) and returns without deleting the kept ref. The ref stays behind.

## 4. Options for R2 (how "stuck" is detected and offered)

| Option | Idea | Verdict |
|---|---|---|
| A. On read | The project and desk queries compute "stuck" live and show Retry on the repository row and the resolved Ship release item. | Rejected. Retry needs a desk item to act on, and `retryReleaseShipIn` keys on the alert. The resolved approval item would need new resolve semantics, and Dismiss would need a second path. |
| B. Timeout only | Mark a ship stuck after N minutes in `committing`. | Rejected. A long fetch or push is "legitimately working" (card AC). A timer would race real results. |
| **C. Sweep → `release_failed`** | A dispatcher pass finds `committing` ships whose `release.ship` command is no longer live (rule below). It cancels any leftover command and appends the normal `ReleaseFailed` plus the "Release stopped" alert. | **Chosen.** It reuses Retry, Dismiss, the R1 guard, the R3 cleanup, the web buttons and the role checks. While the command is live, no alert exists, so Retry is not offered. |

### Stuck rule (R2)

A ship is stuck when all of these hold:

- `release_ships.status = 'committing'`
- its proposal is `approved`
- `updated_at < now - 2 min`
- **no live `release.ship` command** exists for it

A command counts as **live** when its `payload->>'shipId'` is the ship's id and either:

- (i) `status IN ('pending','sent')` and its workstation is `status='active'` and (`connected` OR
  `last_seen_at > now - 30 min`); or
- (ii) `GREATEST(done_at, answering_at) > now - 2 min`. A result was just answered and its apply may still be running.
  This closes the race between `completeCommand` and `applyReleaseShipResult` in finding 2a.

How this covers each case:

- A restart or a short disconnect stays live (the command is requeued on reconnect).
- Cases 2a and 2b become stuck after 2 minutes.
- A removed workstation (2c) is stuck at once.
- A workstation offline for more than 30 minutes (2d) is stuck.

Constants: `RELEASE_SHIP_STUCK_GRACE_SECONDS = 120` and `RELEASE_SHIP_OFFLINE_SECONDS = 1800`. Export them so tests can
use them.

## 5. Design

### 5.1 R1: Retry guard (`apps/server/src/release/ship.ts`)

In `retryReleaseShipIn`, after `failedShipOf` (which keeps the owner check) and the `status !== 'failed'` check, and
**before** any `queue()`, `enqueueReleasePublishFor` or `shipWorkstation` call:

```ts
const proposal = await one(tx, 'SELECT state FROM release_proposals WHERE id=$1 FOR UPDATE', [ship.id]);
if (proposal?.state !== 'approved') throw conflict('release_not_approved', notRetryableReason(proposal?.state));

function notRetryableReason(state: string | undefined): string {
  if (state === 'dismissed') return 'This release was dismissed; it can no longer be retried.';
  if (state === 'released') return 'This release is already released; there is nothing to retry.';
  if (state === 'closed') return 'This release proposal was closed; it can no longer be retried.';
  return 'This release proposal is no longer approved; it can no longer be retried.';
}
```

The guard covers both branches: the resend of `release.ship` and the publish steps (land, tag, publish). A throw rolls
back the transaction of `closeItem`, so nothing is queued and neither the ship, the proposal nor the alert changes. The
web already shows a server message from `resolve.error`.

### 5.2 R2: stuck sweep (new `apps/server/src/release/ship-stuck.ts`)

```ts
export async function releaseShipStuckChecks(ctx: Ctx): Promise<void>
```

1. Select candidate ids with the rule in section 4. Join `release_proposals p ON p.id = s.id AND p.state='approved'`.
   Use `NOT EXISTS (SELECT 1 FROM runner_commands rc JOIN workstations w ON w.id = rc.workstation_id WHERE rc.type='release.ship' AND rc.payload->>'shipId' = s.id::text AND (<live (i)> OR <live (ii)>))`.
2. For each candidate, in `withAppendTx`:
   - Lock the ship row (`SELECT * FROM release_ships WHERE id=$1 FOR UPDATE`) and re-check `status='committing'` plus
     the same `NOT EXISTS`, inside the transaction.
   - Cancel leftover commands:
     `UPDATE runner_commands SET status='failed', last_error='the release was marked stopped; Retry sends it again', done_at=$now WHERE type='release.ship' AND payload->>'shipId'=$1 AND status IN ('pending','sent')`.
     A workstation that comes back then does not run a stale ship. Its late result would be ignored anyway, because
     the ship is no longer `committing`.
   - `appendReleaseFailure(ctx, tx, ship, 'prepare', <text>, false)` with text such as:
     `The workstation stopped answering while it prepared the release commit (it went offline, was removed or lost the request) and never reported a result. If the commit was already pushed, Retry recognises it and makes nothing twice.`
     Optionally add `lost: true` to the alert `data` (useful in tests; the event schema allows it because `data` is
     free).
3. Register the pass in `apps/server/src/dispatcher/phases.ts` right after `release checks`:
   `await step('release ship stuck', () => releaseShipStuckChecks(ctx));`

**Retry of a stuck ship** goes through `retryReleaseShipIn`: step `prepare` is not a publish step, so the stored
payload is resent through `queue()`. The R1 guard applies. Two small changes:

- **Prefer the ship's own workstation**, where the kept ref is. Give `shipWorkstation(db, repoId, userId, preferredId?)`
  an `ORDER BY (w.id = $4::uuid) DESC, (w.user_id = $2::uuid) DESC, w.last_seen_at DESC NULLS LAST`. Pass
  `ship.workstation_id` from Retry. `startReleaseShipIn` passes nothing, so its behaviour is unchanged.
- **Defensive:** before `queue()` with `retry=true`, run the same "cancel live `release.ship` for this ship" UPDATE. Two
  commands for one ship must never be live at once.

**No second commit or tag** (AC R2-b): the runner re-run is idempotent (finding 1). One runner gap remains (finding 6).
In `shipLocked` step 2 (`alreadyDone`), delete the kept ref before returning:

```ts
await git(repoPath, ['update-ref', '-d', keptReleaseRef(version)]);
```

The server then records `ReleaseCommitted {alreadyDone: true}` and the "already had the section: nothing new was
committed" notice. That is the "clear success" end state. A real refusal (for example the tag exists) comes back as
`ReleaseFailed` with its message.

**Web.** No change to `ShipReleaseItem.tsx` is needed or useful: that item is the approval, already resolved once
approved. The stuck ship surfaces as the "Release stopped" alert, which already renders Retry and Dismiss (desktop and
touch; the buttons are the existing desk buttons). The repository row line "preparing the release commit…" stays while
the command is live. Add one web test: a `release_failed` alert with `data.step='prepare'` (the stuck text) shows Retry
and Dismiss. Optional: `releaseStatusLine` may add "(waiting for the workstation)" when the ship's workstation is
offline. That needs a new DTO field, so leave it out unless it is cheap.

### 5.3 R3: kept ref cleanup on Dismiss

**Protocol** (`packages/shared/src/protocol/runner.ts`, next to `release.ship`):

```ts
/** `release.ref_cleanup`: deletes the kept ref refs/guildwise/release/<version> of an abandoned release. */
export const RELEASE_REF_CLEANUP_CAPABILITY = 'release-ref-cleanup:1';
export const KEPT_RELEASE_REF_PREFIX = 'refs/guildwise/release/';
export const keptReleaseRef = (version: string): string => `${KEPT_RELEASE_REF_PREFIX}${version}`;
export const ReleaseRefCleanupPayloadSchema = z.object({
  shipId: z.uuid(),
  repoId: z.uuid(),
  remoteUrlNormalized: z.string().min(1).max(500),
  version: ReleaseShipPayloadSchema.shape.version, // same refine: RELEASE_TAG_RE on `v${version}`
});
export const ReleaseRefCleanupResultSchema = z.object({
  ok: z.boolean(),
  deleted: z.boolean().default(false),
  error: z.string().max(500).optional(),
});
```

Also add `'release.ref_cleanup'` to `RunnerCommandNameSchema`, and add
`'release.ref_cleanup': ReleaseRefCleanupPayloadSchema` to `CommandPayloadSchemas`.

The payload carries the **version**, not a ref name. The runner builds the ref itself, so no caller can name another
ref.

**Runner** (`apps/runner/src/git/release-ship.ts`):

```ts
export async function deleteKeptReleaseRef(repoPath: string, version: string): Promise<ReleaseRefCleanupResult> {
  const ref = keptReleaseRef(version);
  if (!isSafeGitRef(ref) || !ref.startsWith(KEPT_RELEASE_REF_PREFIX) || ref.slice(KEPT_RELEASE_REF_PREFIX.length).includes('/'))
    return { ok: false, deleted: false, error: `refusing unsafe ref ${JSON.stringify(ref)}` };
  return withRepoLock(repoPath, async () => {
    if (!(await revParse(repoPath, ref))) return { ok: true, deleted: false };
    const r = await git(repoPath, ['update-ref', '-d', ref]);
    return r.exitCode === 0 ? { ok: true, deleted: true } : { ok: false, deleted: false, error: (r.stderr || r.stdout).trim().slice(0, 500) };
  });
}
```

- Replace the three literals `refs/guildwise/release/${…}` in `shipLocked`, `commitRelease` and `pushCommit` with
  `keptReleaseRef(…)`.
- Dispatch in `Runner.runCommand` (`runner.ts`, after `release.ship`): parse the payload and run `findRepo`. With no
  clone, answer `done(true, { ok: true, deleted: false })`. Otherwise answer
  `done(true, await deleteKeptReleaseRef(repo.localPath, p.version))`. A schema refusal (a bad version) throws inside
  `parse`, and the existing catch answers `ok:false`.
- Announce `RELEASE_REF_CLEANUP_CAPABILITY` in the `hello` capabilities list.
- Raise `RUNNER_VERSION` as the repository usually does for a protocol addition, if that is the convention on this line.

**Server: Dismiss** (`dismissReleaseShipIn`): change the return type to `Promise<string[]>`, the workstations to deliver
to. After appending `ReleaseProposalClosed`, and only when the proposal was really dismissed here, unless the failed step
is a publish step (the commit was pushed and the ref is already gone):

```sql
SELECT w.id FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
  JOIN workstation_capabilities wc ON wc.workstation_id = w.id
 WHERE wr.project_repo_id=$1 AND w.status='active' AND $2 = ANY (wc.capabilities)
```

Use `[ship.repo_id, RELEASE_REF_CLEANUP_CAPABILITY]`. There is **no** `connected` filter, so an offline workstation gets
the command when it reconnects (`deliverPending` on reconcile). For each workstation, run
`enqueueRunnerCommand(tx, wsId, 'release.ref_cleanup', { shipId, repoId, remoteUrlNormalized, version })`. Read
`remoteUrlNormalized` from `ship.payload` (or from `project_repos`).

Queue to every capable workstation that has the clone, not only `ship.workstation_id`. A Retry may have moved the ship
to another workstation, and each one may hold a kept ref. The cleanup is idempotent.

A workstation without the capability (older runner) gets nothing. That is "treated as not supported", and the ref stays
there, as it does today. Log it at debug level.

**Server: `desk.ts`.** In the `release_failed` branch, collect the returned ids. After the transaction, deliver them
fire-and-forget, so Dismiss never waits for the runner:

```ts
for (const ws of cleanupWorkstations) void Promise.resolve(ctx.services.gateway.deliverPending(ws)).catch(() => undefined);
```

**Server: result** (`handlers.ts` `applyCommandResult`): add an explicit branch for `release.ref_cleanup`. It is
terminal: `completeCommand(true)`. If `ReleaseRefCleanupResultSchema` parses to `ok:false`, log a warning with the
error. Do not retry: a refusal cannot change, and a missing ref is already a success.

**Ordering.** Commands are delivered in `created_at` order per workstation. The cleanup queued at Dismiss therefore runs
before a later `release.ship` of a new proposal for the same version on that workstation, so the new ship never resumes
the abandoned kept commit.

### 5.4 Files

| File | Change |
|---|---|
| `apps/server/src/release/ship.ts` | R1 guard; `shipWorkstation` preferred workstation; cancel live ship commands before a retry queue; `dismissReleaseShipIn` queues `release.ref_cleanup` and returns workstation ids |
| `apps/server/src/release/ship-stuck.ts` (new) | `releaseShipStuckChecks`, the constants |
| `apps/server/src/dispatcher/phases.ts` | register the sweep |
| `apps/server/src/commands/desk.ts` | deliver the cleanup workstations after the transaction (fire-and-forget) |
| `apps/server/src/runner-gateway/handlers.ts` | `release.ref_cleanup` result branch |
| `packages/shared/src/protocol/runner.ts` | capability, prefix helper, payload and result schemas, command name, payload map |
| `apps/runner/src/git/release-ship.ts` | `deleteKeptReleaseRef`, `keptReleaseRef` everywhere, delete the kept ref on `alreadyDone` |
| `apps/runner/src/runner.ts` | dispatch and capability |
| Tests | `apps/server/test/release-ship.test.ts`, `apps/runner/test/release-ship.test.ts`, `apps/web/src/test/desk.test.tsx` (only if not already covered) |
| Docs | `docs/ARCHITECTURE.md` (~2295-2296: R1 guard, stuck sweep, cleanup), `docs/RUNNER.md` (new `### release.ref_cleanup` after `release.ship`, capability, kept ref removed on `alreadyDone`), `docs/USER-GUIDE.md` (~651: a lost workstation shows "Release stopped" with Retry; Retry after Dismiss is refused; Dismiss removes the kept commit), `CHANGELOG.md` Unreleased (one Fixed line; GWP-166 tidies the headings later) |

There is no migration: `runner_commands` and `release_ships` already have every column the design needs (`done_at`,
`answering_at`, `sent_at`, `updated_at`, `last_seen_at`, `connected`).

## 6. Acceptance criteria → design → test

| AC | Design | Test |
|---|---|---|
| Record what was present | Section 2 (R1 no, R2 no, R3 partly) | posted on the card |
| R1: failed + approved → Retry queues | Unchanged path after the guard | server: existing test "a failed result … Retry queues" stays green |
| R1: dismissed → 409, nothing queued, no state change | 5.1 guard before any queue | server: fail → Dismiss → Retry on the same (closed) alert → 409 `release_not_approved` with "dismissed" in the message; `release.ship` count unchanged; ship `failed`, proposal `dismissed`, no new `ReleaseShipStarted` |
| R2: stuck shows Retry/Dismiss; while working, not offered | 5.2 sweep and stuck rule | server: ship `committing` with command `sent` on a connected workstation → sweep does nothing (no alert); mark the command `done` with `done_at` 3 min ago (or delete it, or set the workstation `status='removed'`, or disconnected with `last_seen_at` 31 min ago) → sweep makes one `release_failed` alert with options retry/dismiss, ship `failed` step `prepare`; second sweep adds nothing; `done_at` 30 s ago → no alert. Web: alert renders Retry and Dismiss |
| R2: Retry re-queues on the ship workstation; pushed already → no second commit/tag | 5.2 preferred workstation; runner idempotency and kept ref delete on `alreadyDone` | server: Retry after the sweep → new `release.ship` on `ship.workstation_id`, old one `failed`; apply an `alreadyDone` result → `committed`. Runner: push done, kept ref left (simulate with `update-ref`) → re-run answers `alreadyDone`, one release commit on origin, no tag, kept ref gone |
| R2: Retry with proposal not approved refused | 5.1 (same function) | server: stuck → alert → set the proposal `dismissed` → Retry 409, nothing queued |
| R3: Dismiss queues removal; the ref is gone after | 5.3 | server: fail at `push` → Dismiss → one `release.ref_cleanup` per capable clone workstation with `version`. Runner: kept ref present → `deleteKeptReleaseRef` → `deleted:true`, `for-each-ref` has no `refs/guildwise/release` |
| R3: only under the prefix, missing ok, offline later, Dismiss does not wait | 5.3 | runner: missing ref → `{ok:true, deleted:false}`; version `1.4.0/../../heads/develop` (or with `..`) → refused, `develop` intact; payload schema refuses a non-version. Server: workstation `connected=false` → command still queued `pending` (delivered on reconnect by the existing reconcile); workstation without the capability → no command; Dismiss returns 200 without any runner answer |
| typecheck, lint, test, format | — | `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit), `pnpm format` on touched files |

## 7. Risks

- **Late success after a stuck mark.** A workstation offline more than 30 minutes that was mid-push may push, then come
  back. Its result is ignored, because the ship is `failed`. The owner sees "Release stopped" while the commit is on the
  branch. Retry resolves it in one click (`alreadyDone`). Dismiss in that state abandons a release whose commit is
  already on the working branch. That is the same as Dismiss after any failed push that actually went through today, so
  it is not new.
- **Sweep vs. apply race.** Handled by live rule (ii) and the in-transaction re-check with `FOR UPDATE`. Both
  `applyReleaseShipResult` and the sweep lock the ship row, and each re-checks `status='committing'`.
- **Older runners.** They never get `release.ref_cleanup` (capability gate), so a kept ref can remain on them, as today.
  An older runner that receives the frame anyway (it should not) drops it without crashing.
- **Shared files with GWP-166** (format and CHANGELOG headings): run `pnpm format` only on the files touched here, and
  leave the duplicate `### Added` merge to GWP-166.
- **Role checks unchanged.** `failedShipOf` and `dismissReleaseShipIn` keep the owner-only check. The sweep acts as
  `SYSTEM_ACTOR`.
