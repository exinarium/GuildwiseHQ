# GWP-95: the workstation shift limit is not honoured or kept in sync

## 1. The question

On 2 Nov the runner turned shifts away with `4 shifts already running (limit 4)`. The owner had set the
workstation to Unlimited on the Workstations page. GWP-90 stayed queued, and the new builder got no shifts, while four
shifts (GWP-94, GWP-91, GWP-68 and a DevOps shift) held every slot. Four questions:

1. Where does the runner get its effective maximum, in what order, and why did 4 win over Unlimited?
2. Does a change on the page reach a connected runner and apply without a restart?
3. Why did the page not show that the effective limit was 4?
4. Do chat, CEO and mention shifts count toward the cap?

After that comes the design for R1 to R6.

## 2. Findings

### 2.1 Q1: where the limit comes from and in what order

The runner enforces the limit in one place, `ShiftSupervisor.handleStart` (`apps/runner/src/shifts/supervisor.ts:512`):

```ts
const max = this.deps.maxConcurrentShifts?.() ?? this.deps.config.maxConcurrentShifts;
```

`Runner` supplies `maxConcurrentShifts` (`apps/runner/src/runner.ts:698`):

```ts
maxConcurrentShifts: () => Math.min(this.maxConcurrent, this.opts.sharedCap?.() ?? Number.POSITIVE_INFINITY),
```

The limit has two parts, and the smaller one wins:

**a) `Runner.maxConcurrent`: the pairing's own limit.**

| When | Value |
|---|---|
| Process start (`runner.ts:460`) | `server-limits.json` → `maxConcurrentShifts` (the last value the server enforced), else `config.json` `maxConcurrentShifts` (default 4, `config.ts:265`) |
| `welcome` (`runner.ts:853`) and `shifts.limit` (`runner.ts:1969`) with `shiftLimit` a number or `unlimited` | the server's `maxConcurrentShifts` exactly (owner setting under the platform cap; Unlimited = platform cap, or 100 000 with no cap). Saved to `server-limits.json` |
| the same with `shiftLimit: null` (owner chose "Runner's own value") | `min(server value, config.json maxConcurrentShifts)`, and `server-limits.json` is deleted |
| the same with `shiftLimit` undefined (older server) | `min(server value, config.json maxConcurrentShifts)` |

In this part the server setting already wins over `config.json`. When the runner has received an Unlimited setting,
the config value of 4 does not lower it.

**b) `sharedCap`: the machine budget across pairings** (`apps/runner/src/host.ts:124-144`).

```ts
private machineLimit(): number {
  const index = loadIndex(this.opts.root);
  if (index.maxConcurrentShifts) return index.maxConcurrentShifts;   // <-- wins outright
  let max = 1;
  for (const r of this.running.values())
    max = Math.max(max, loadSafe(entryConfigPath(...))?.maxConcurrentShifts ?? 4, r.runner.shiftLimit());
  return max;
}
private capFor(id) { return Math.max(0, this.machineLimit() - <supervisor.size of the other pairings>); }
```

`pairings.json`'s `maxConcurrentShifts` (`pairings.ts:36`) is a local, hand-edited value. Nothing writes it: no CLI
command, and neither pairing nor the server. When it is present it is the machine limit, whatever the server granted.
So a local value of 4 in `pairings.json` caps every pairing at 4 even when the workstation is Unlimited. Neither
the server nor the page ever learns about this cap.

**Why 4 won on 2 Nov.** The code allows only two ways to produce `(limit 4)` while the server holds Unlimited:

1. **The machine budget (most likely).** This workstation uses the multi-pairing layout: the pairing's data
   directory is `pairings/<id>`, not `.`, so `RunnerHost` and `sharedCap` are active. A `maxConcurrentShifts: 4` in
   `pairings.json` gives `min(16 or 100000, 4 - 0) = 4`. That matches both what the owner saw ("the runner config file
   held limit 4") and the exact message.
2. **The setting never reached the runner.** The runner then kept `config.json`'s 4. This happens if the setting
   was still null when the shifts were turned away (`min(server, config 4) = 4`), or if `shifts.limit` was not
   delivered (see 2.2). After the next reconnect `welcome` would have fixed it, and the owner reports it did not.

A read-only check of the actual `pairings.json`, `config.json` and `server-limits.json` values on this
workstation was requested from DevOps (request 2234afc7). The answer had not arrived when this report was written. The
builder should record the result on the card (AC 8). **The fix below removes both causes either way.**

On the server, precedence is `effectiveShiftLimit` (`apps/server/src/runner-gateway/shift-limit.ts:19`): the setting,
else the value the runner reports from its config, always under `platformShiftCap` (`AOM_MAX_SHIFTS_PER_WORKSTATION`,
default 16, `0` = none).

### 2.2 Q2: is a change pushed and applied without a restart?

Yes, with gaps. `setShiftLimit` (`commands/workstations.ts:164`) appends `WorkstationShiftLimitSet`. Then, if a
connection for the workstation exists **in this server process**, it updates `conn.maxShifts`. If the runner announced
`shift-limit:1`, it also queues a `shifts.limit` command, delivers it and triggers the dispatcher. The runner applies it
at once (`runner.ts:1966`): only `maxConcurrent` changes, so the next `handleStart` uses it and running shifts are never
touched. At the next `hello`, `welcome.limits` carries the setting (`handlers.ts:959-965, 1073`).

Gaps:
- The push changes only part (a). The machine budget (b) is local and stays, so Unlimited cannot lift a `pairings.json` cap.
- The runner never says what it enforces. The command result (`{maxConcurrentShifts}`) is not used for the page.
- With no local connection, nothing is queued. The value then waits for the next `welcome`.

### 2.3 Q3: why the page did not show 4

`shiftsDto` (`queries/misc.ts:476`) shows the server's own view: `conn.maxShifts`, which for Unlimited is the platform
cap (16 by default) or `UNLIMITED_SHIFTS`, shown as "unlimited". `runnerLimit` is the runner's `config.json` value
from `hello`, used only as a hint in the edit form (`ShiftLimit.tsx:58`) and never compared. The value the runner
really enforces, `min(maxConcurrent, sharedCap)`, is reported nowhere: the heartbeat carries only `runningShifts`.
The page had no way to know it was 4.

### 2.4 Q4: which shifts count

| Shift kind | Runner, same pairing (`supervisor.ts:516`) | Runner, other pairings (`host.ts:142`, `supervisor.size`) | Server dispatcher (`dispatcher.ts:231`) | Page count (`misc.ts:557`) |
|---|---|---|---|---|
| card, question, devops, ba_task | counted | counted | counted | counted |
| ceo | **own slot** (one at a time) | **counted** | **counted** | **counted** |
| chat (owner chat, CEO owner/order turns, @mention work, which runs as a chat turn in `ChatManager`) | not counted (separate `ChatManager`) | not counted | not counted | **counted** (all `status <> 'ended'`) |

The three counts disagree: CEO is counted in three places but not in the runner's own check, and chat is counted only
on the page. With one chat and N card shifts, the page shows N+1, the dispatcher N, and the runner N.

## 3. Options

**A. Make the server the only source, retire the local caps (recommended).**
- The runner takes the server's value whenever the server has sent one. `config.json` is used only as the
  value for "Runner's own value" (an explicit owner choice) and before the first answer.
- `pairings.json maxConcurrentShifts` is ignored and logged once. The machine budget becomes the largest limit
  the servers granted, so several pairings still share one budget, but nothing local lowers it below a server setting.
- The runner reports what it enforces (value + source) in the heartbeat, and the page compares the two.
- Costs: additive protocol fields and one new capability. No migration, no new table.

**B. Keep the local caps, but report them.** The runner reports `sharedCap` and the page shows the mismatch. This
breaks R1 ("a value in the runner's local config must not lower the limit below the server setting") and AC 1.

**C. Push the setting into `pairings.json` / `config.json` from the server.** This rewrites owner files (the
constraints forbid it), and it gets complicated with several pairings that have different servers.

**Recommendation: A.**

## 4. Design

### 4.1 Rules to document (R1, R3, R6)

- **Precedence (runner).** (1) The server's value from the last `welcome`/`shifts.limit` of this process. (2) Before
  any answer from this server since the process started, `server-limits.json` (the last value the server sent),
  else `config.json` `maxConcurrentShifts`. This is the *local fallback*. (3) If the owner chose "Runner's own value"
  (setting null), `config.json` under the platform cap. This is an owner choice, shown as source *runner config*.
  `pairings.json` `maxConcurrentShifts` is **retired**: it is read only to log once that it is ignored. The file is left
  alone.
- **Unlimited** = no workstation cap. Only the platform cap applies, and the page names it.
- **What counts (R6):** a shift takes a slot if its kind is `card`, `question`, `devops` or `ba_task`. `ceo` (its own slot,
  one at a time) and `chat` (all chat turns, CEO owner/order turns and @mention work) take no slot. The runner (same
  pairing and cross-pairing), the dispatcher and the page all use this one rule.
- **Several pairings on one machine:** the machine budget is the largest limit any running pairing's server granted.
  The pairings share it first come, first served (as today). A shift turned away by the budget names the source
  *pairing budget*.

### 4.2 packages/shared

`src/protocol/runner.ts`:

```ts
/** Where the shift limit in force comes from. */
export const SHIFT_LIMIT_SOURCES = ['workstation_setting', 'platform_cap', 'runner_config', 'local_fallback', 'pairing_budget'] as const;
export const ShiftLimitSourceSchema = z.enum(SHIFT_LIMIT_SOURCES);
export type ShiftLimitSource = z.infer<typeof ShiftLimitSourceSchema>;
/** Runner announces: reports the limit it enforces (heartbeat), ignores pairings.json's cap, sends `capacity` on busy. */
export const SHIFT_LIMIT_REPORT_CAPABILITY = 'shift-limit:2';
/** Shift kinds that take no slot of the workstation's shift limit (R6). */
export const SHIFT_KINDS_OUTSIDE_LIMIT = ['chat', 'ceo'] as const;
export const takesShiftSlot = (kind: string) => !(SHIFT_KINDS_OUTSIDE_LIMIT as readonly string[]).includes(kind);
```

Additive fields. For a reader, every new field is optional. A source the reader does not know must not break the
message, so on the wire use `z.string().max(40)` and narrow it with `ShiftLimitSourceSchema.safeParse` on the reading
side (or `.catch(undefined)`):
- `WelcomeSchema.limits.source?` and `'shifts.limit'.source?`: the server's source (`workstation_setting` | `platform_cap` | `runner_config`).
- `HeartbeatSchema.load`: `maxShifts?: int positive` (the effective limit the runner enforces now, 100 000 = none) and `limitSource?: string`.
  `runningShifts` becomes the slot count (kinds that take a slot).
- `ShiftRejectedSchema.capacity?`: `{ limit: int, source: string, running: int, holders: Array<{ shiftId: uuid, kind: string, cardRef?: string(max 40), agentName?: string(max 80) }>.max(50) }`.
  Identifiers only: no paths, no titles.

`src/api/workstations.ts` `shifts` (all with `.default(...)` so old payloads still parse):
- `source: ShiftLimitSource | null`: the server's source, null offline with no setting.
- `enforced: { limit: number | null /* null = none */, source: ShiftLimitSource } | null`: what the runner reports. null when
  it is offline, has not reported yet, or lacks `shift-limit:2`.
- `sync: 'in_sync' | 'applying' | 'mismatch' | 'unknown'`.
- `otherRunning: int`: chat and CEO turns running now (not counted).
- `holders: Array<{ shiftId, kind, cardRef: string | null, agentName: string | null }>`: the slot-taking shifts running now.

### 4.3 apps/runner

- **`host.ts`**
  - `machineLimit()` becomes `max(1, ...running.map(r => r.runner.shiftLimit()))`. Drop the `index.maxConcurrentShifts`
    branch and the per-pairing config term. When `index.maxConcurrentShifts` is set, log once: "pairings.json
    maxConcurrentShifts (N) is no longer used: the Workstations page decides".
  - In `capFor`, count the other pairings with `supervisor.slotCount`, not `size`.
- **`runner.ts`**
  - Replace `maxConcurrent: number` with `limit: { max: number; source: ShiftLimitSource }`.
  - Start: `server-limits.json` → `{max: saved.maxConcurrentShifts, source: 'local_fallback'}`, else
    `{config, 'local_fallback'}`.
  - `applyShiftLimit(shiftLimit, serverMax, source?)`:
    - number or unlimited → `{serverMax, source ?? derive}`, where derive gives `platform_cap` when `serverMax` is below
      the setting (or below `UNLIMITED_SHIFTS` for Unlimited), else `workstation_setting`. Saved as today.
    - null → `{min(serverMax, freshConfig().maxConcurrentShifts), 'runner_config'}`, and the file is cleared.
    - undefined (old server) → today's behaviour, source `runner_config`.
  - New `effectiveShiftLimit()`: `shared = opts.sharedCap?.()`. Return
    `shared < limit.max ? {max: shared, source: 'pairing_budget'} : limit`. `shiftLimit()` (used by the host) returns
    `limit.max` (the grant, not reduced by the budget, to avoid circularity).
  - Supervisor dep: `shiftCap: () => this.effectiveShiftLimit()` (replaces `maxConcurrentShifts`).
  - Heartbeat: `load: { runningShifts: supervisor.slotCount, maxShifts: eff.max, limitSource: eff.source }`.
    The `shifts.limit` result also returns `{maxConcurrentShifts, source}`.
  - Add `SHIFT_LIMIT_REPORT_CAPABILITY` to the capabilities. `hello.maxConcurrentShifts` stays the `config.json`
    value (it is "Runner's own value"); read it with `freshConfig()`.
- **`shifts/supervisor.ts`**
  - `get slotCount()` counts `active` whose `takesShiftSlot(msg.kind)`.
  - `handleStart`:

    ```ts
    const cap = this.deps.shiftCap?.() ?? { max: this.deps.config.maxConcurrentShifts, source: 'runner_config' };
    const holders = [...this.active.values()].filter((a) => takesShiftSlot(a.msg.kind));
    if (!isCeo && holders.length >= cap.max) {
      const refs = holders.map((h) => h.msg.brief.card?.ref ?? h.msg.kind).join(', ');
      this.reject(msg.shiftId, 'busy',
        `${holders.length} shifts already running (limit ${cap.max}, ${SOURCE_LABEL[cap.source]}): ${refs}`.slice(0, 500),
        { capacity: { limit: cap.max, source: cap.source, running: holders.length,
            holders: holders.slice(0, 50).map((h) => ({ shiftId: h.msg.shiftId, kind: h.msg.kind,
              ...(h.msg.kind === 'card' && h.msg.brief.card ? { cardRef: h.msg.brief.card.ref } : {}),
              agentName: h.msg.agent.name.slice(0, 80) })) } });
      return;
    }
    ```

    `reject()` needs an optional extra-fields argument. The CEO check stays as it is.
- `chat/chat.ts`: no change (chats take no slot). Document it.

### 4.4 apps/server

- **`runner-gateway/shift-limit.ts`**
  - `shiftLimitSourceOf(ctx, setting, effective)`: `null` → `runner_config`; number above the cap or unlimited under a cap → `platform_cap`; otherwise `workstation_setting`.
  - `SLOT_KINDS_SQL = "kind NOT IN ('chat','ceo')"`, built from `SHIFT_KINDS_OUTSIDE_LIMIT`.
- **`registry.ts` `RunnerConn`**: add `limitSource?`, `enforcedMaxShifts?`, `enforcedSource?`, `enforcedAt?: Date` and
  `limitChangedAt?: Date`.
- **`handlers.ts`**
  - `hello`: set `conn.limitSource`, and set `conn.limitChangedAt = now`.
  - `welcome.limits`: add `source`.
  - `heartbeat`: store `load.maxShifts`, the safe-parsed `limitSource` and `enforcedAt = now`. Only memory; nothing to persist.
- **`commands/workstations.ts` `setShiftLimit`**: add `source` to the payload, set `conn.limitChangedAt = now`.
  Everything else stays (event sourced through `WorkstationShiftLimitSet`, no new event).
- **`dispatcher/dispatcher.ts`**
  - `shiftLoad`: count with `SLOT_KINDS_SQL` instead of `kind <> 'chat'`.
  - `full()`: limit = `min(conn.maxShifts, conn.enforcedMaxShifts ?? ∞)`, so the dispatcher stops offering what the runner
    will turn away. After this fix that only happens under a pairing budget.
- **`commands/shifts.ts` `applyShiftRejected`**: when `reason === 'busy'` and `msg.capacity` is set, the card message
  becomes "Waiting: workstation <name> is at its shift limit (<limit>, <source label>). Slots held by GWP-94 (Ada),
  GWP-91 (Ken), GWP-68 (Barbara), devops (Anvil). The card is back in the queue." Without `capacity`, the text stays
  as today. `ShiftEnded.rejectionReason` already stores `busy: <detail>`, and the detail now names the limit, source and
  holders: that is the server-side record (R5). No new event is needed.
- **`queries/misc.ts`**
  - The `running` query becomes two counts: slot kinds and others.
  - Add a holders query: `shifts s LEFT JOIN cards c ON c.id = s.card_id JOIN agents a ON a.id = s.agent_id
    WHERE s.status <> 'ended' AND <SLOT_KINDS_SQL>`, giving the shift id, kind, `c.ref` and `a.name`.
  - `shiftsDto` fills `source`, `enforced` (only with `shift-limit:2` in caps and `enforcedAt` set), `sync`, `otherRunning`
    and `holders`. `sync` is:
    - `unknown`: offline, or the runner lacks `shift-limit:2`;
    - `applying`: no heartbeat since `limitChangedAt`;
    - `mismatch`: `enforcedMaxShifts !== conn.maxShifts`, or the enforced source is `pairing_budget`;
    - `in_sync`: otherwise.

### 4.5 apps/web

- **`pages/Workstations.tsx` (~413)**
  - Show `"<running> of <limit> · <source label>"`, or `"<running> · no limit"`. Source labels: workstation setting, platform
    cap, runner config, runner local fallback, shared with other pairings.
  - Show `"+<otherRunning> chat/CEO (not counted)"` when there are any.
  - When `running >= limit`: a line "Full: new shifts wait. Held by GWP-94 (Ada), …" from `holders`.
- **`components/workstations/ShiftLimit.tsx`**
  - `sync === 'mismatch'`: a visible `role="status"` warning, for example "The runner enforces 4 (shared with other pairings
    on this machine), not 16 as set here."
  - `unknown` on an online runner: "This runner does not report the limit it enforces: update it."
  - `applying`: a muted "Applying…".
  - Rename the "Runner's own value" hint to "Runner's config value: N".
- All of this is plain visible text, so it works on touch devices too: no hover-only tooltips, and the lines wrap
  on narrow screens.

### 4.6 Docs

- `docs/RUNNER.md`
  - :365 (concurrency budget): `pairings.json` key retired; the budget is the largest grant.
  - :511-512: new precedence and local fallback; the `shift-limit:2` heartbeat report.
  - :1736: the CEO/chat rule (R6).
- `docs/ARCHITECTURE.md`
  - :1600 (sharedCap).
  - :1619 and :1648: `hello`/`welcome` rows plus the heartbeat `load` fields.
  - :1264: dispatcher `full()` and the slot rule.

## 5. Risks

- **Mixed versions.**
  - New server with an old runner: no `shift-limit:2`, so `sync = unknown` and today's behaviour stays. The old
    runner ignores the new fields because zod objects strip unknown keys.
  - Old server with a new runner: no `source` and no `shiftLimit`, so the runner keeps today's `min(server, config)`.
  - Never use `.strict()` or a bare enum for new wire fields. That is why the source travels as a string.
- **Behaviour change for machines that set `pairings.json` on purpose:** they lose that local cap. This is what R1 asks
  for, and it is documented and logged once. The Workstations page number replaces it.
- **CEO no longer counted on the server:** the dispatcher may offer one more card shift to a workstation running a CEO
  shift. The runner already accepts it (the CEO has its own slot), so this only fixes needless holds.
- **A heartbeat race** could flag a mismatch right after a change. The `limitChangedAt`/`applying` state covers it.
- **Several server instances:** `setShiftLimit` pushes only when this process holds the socket; otherwise the value
  arrives with the next `welcome`. This is unchanged and noted. If deployments run several instances, a follow-up can
  enqueue `shifts.limit` without a local connection.
- **Overlap with GWP-94** (dispatcher, in review): different lines (`shiftLoad`/`full`). No dependency is recorded;
  merge main before building.

## 6. Acceptance criteria → design

| AC | Covered by |
|---|---|
| 1. config 4 + Unlimited → 5th and 6th shift start without a restart | 4.3 `applyShiftLimit` (server value wins) and the retired `pairings.json` cap in `machineLimit`. Runner test (a) |
| 2. number↔unlimited↔number applies at the next start, nothing killed | existing `shifts.limit` push; the limit is read per `handleStart`. Runner test (d); server test "push without reconnect" |
| 3. After restart/reconnect, the server setting rules | `welcome` → `applyShiftLimit`; the local fallback only until then. Runner test (c) plus restart |
| 4. The page shows limit, source and running count, matching the runner | 4.4 `shiftsDto` (`source`, `enforced`, slot `running`), 4.5 page line. Server and web tests |
| 5. Mismatch warning | `sync = mismatch` from the heartbeat `maxShifts`. Web and server tests |
| 6. Rejection names value, source and holders, visible to the manager | supervisor `capacity` + detail; card system message; `ShiftEnded.rejectionReason`; "Full: held by" on the workstation. Runner test (e), server test |
| 7. Chat/CEO rule documented, three counts agree | `takesShiftSlot` / `SLOT_KINDS_SQL` used in supervisor, host, dispatcher and misc. Runner test (f), server test with 1 chat + N card |
| 8. The four answers on the card | section 2 of this report. The builder adds the DevOps check of the real files |

## 7. Tests (unit only)

- **`apps/runner/test/shift-limit.test.ts`**
  - (a) config 4 + welcome `unlimited`/16: the effective limit is 16 and a 5th start is accepted.
  - (b) config 4 + server 6: 6.
  - (c) no welcome yet: `local_fallback` from `server-limits.json`, else config.
  - (d) `shifts.limit` while shifts run: none stopped, and the next start uses the new value.
  - (e) the busy rejection carries `capacity` with the limit, the source and the holder refs.
  - (f) a CEO shift and a chat take no slot.
  - Host: `pairings.json` `maxConcurrentShifts: 4` no longer caps an Unlimited grant. Two pairings share the largest
    grant, and a rejection names `pairing_budget`.
- **`apps/server/test/workstation-shift-limit.test.ts`** (fake runner)
  - The push carries `source`.
  - The heartbeat `maxShifts` fills `enforced`, and a different value gives `mismatch`.
  - No `shift-limit:2` gives `unknown`.
  - `applyShiftRejected` busy + `capacity` writes the card message with the holders.
  - `shiftLoad` and the DTO count leave out `chat` and `ceo`.
  - The platform cap still holds over Unlimited.
- **`apps/web/src/test/shift-limit.test.tsx`**: the source label, the running count with the "not counted" note, the
  mismatch, unknown and applying texts, the holders on a full workstation, and that Unlimited sends `'unlimited'`.
- Leave for testers: the manual steps 1-4 of the card's test plan (a real runner with several shifts).
