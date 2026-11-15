# GWP-202: Owner-pending items, a reminder after 2 working days (state unchanged)

Source: PRD "Review Gates & Reviewer Workflow" v22 (doc 61871304), section F1.5: "for owner-pending items (second timeout within budget, manual triggers, extra spend beyond the daily cap): if the owner hasn't acted after 2 working days, the item stays 'not reviewed' and the owner gets a reminder." Section 6 (size check): a size exception request lapses after 2 working days and the owner gets **no** reminder (GWP-210).

## 1. The question

Build a generic, restart-safe timer that:

1. is registered by the feature that creates an owner-pending item (`registerOwnerPending`), so GWP-209 (second timeout), GWP-200/201 (manual trigger, extra spend beyond the daily cap) only call one function;
2. after 2 working days without owner action, reminds the owner **once** and changes nothing about the item (it stays "not reviewed");
3. is cancelled by any owner action;
4. never reminds for a size exception request.

Open design points from the card: the working-day definition (weekends, holidays, time zone), where the reminder shows (desk, push), persistence of the due time, once-only.

## 2. Findings in the code

| What | Where | Use here |
|---|---|---|
| Open-item reminders (3 days, push category `follow_ups`, item shows "Reminded", one per window) | `apps/server/src/commands/follow-up.ts` (`followUpSweep`), `packages/shared/src/agent-ux/follow-up.ts` (pure `followUpAction`), projection `desk_follow_ups` in `projections/agent-ux.ts` | The pattern to copy: candidates query, then per item an advisory-locked transaction that re-reads projected state and appends one event; the push is sent after the commit with `notifyUsers`. A pure decision function in shared keeps the rule unit-testable. |
| Restart-safe timer with a persisted deadline | `journeys/waits.ts`, `projections/journey-waits.ts` (`next_fire_at`, `reminders_sent`, the `firedFor` guard), migration `2840_journey_waits.sql` | Persist the due instant in a projection row and guard the fire with `firedFor = due_at`, so a replay or a second sweep changes nothing. |
| Scheduler | `apps/server/src/scheduler/scheduler.ts` main pass (every 15 s and on boot), `followUpSweep` is called at line 176 | Add `ownerPendingSweep(ctx)` right after `followUpSweep`. A sweep that was missed while the server was down fires on the first pass after boot. |
| Fake clock | `apps/server/src/clock.ts` (`ctx.clock.now()`, `setOffset`, `advance`), tests use `w.t.clock` | All time reads go through `ctx.clock`. Tests pin an instant with `w.t.clock.setOffset(Date.parse(iso) - Date.now())`. |
| Desk alert with subject key, addressed to one person | `delivery/notices.ts` (`raiseDeskNotice`/`closeDeskNotice`), `desk-port.ts` (`addresseeUserId`), `DeskItemCreated` schema in `packages/shared/src/events/desk.ts` | The in-app reminder: a non-blocking `alert` with `addresseeUserId`, `subjectKey` and `data`. `alert` is not in `FOLLOW_UP_KINDS`, so the 3-day chase never reminds about the reminder; a non-blocking alert gets no automatic push in `push/notifier.ts` `onDeskItem`, so our sweep sends the one push itself. |
| Push | `push/notifier.ts` `notifyUsers` (category switch, quiet hours, 24 h dedupe per subject+state), categories in `packages/shared/src/api/push.ts` | Reuse category `follow_ups` ("Reminders for open items"). |
| Time-zone maths | `packages/shared/src/reporter/index.ts` (`isValidTimeZone`, `localParts`), `packages/shared/src/video/schedule.ts` (`zonedWallToUtc`, `localDate`; exported through `video/index.ts`) | Reuse; no new date library. |
| Owner time zone | `users.timezone` (migration `1304_ba_reporter.sql`, nullable). `ownerTimezone` in `commands/schedule-actions.ts` reads a schedule row, then `users.timezone`, else `'UTC'` | Same rule, for a user id: `users.timezone` if valid, else `'UTC'`. `ownerTimezone` itself takes a schedule row, so it is not called directly; a small `userTimezone(db, userId)` with the same fallback is added next to it (or in the new module). |
| Working-day helper | none (no weekend/holiday/business-day code; `delivery/gate.ts` has a weekday-of-now helper only) | New helper in shared. |
| PR review workflow (PR states, "not reviewed", daily cap, manual trigger) | not in this repository yet (GWP-197 to GWP-201, GWP-209, GWP-210 are in design) | The timer must not know PR states. It stores a generic subject reference and never writes the item's state. |

## 3. Options

### 3.1 Where the timer lives

| Option | For | Against |
|---|---|---|
| A. Generic event-sourced timer: its own events, a projection table `owner_pending_timers`, a sweep (recommended) | Restart-safe (the due time is in the log and the projection), replay-safe, one register/resolve API for every sibling card, unit-testable rule, same shape as journey waits and follow-up | One migration, one events file |
| B. Put the timer on desk items (owner-pending items as desk questions chased by `followUpSweep` with a 2-working-day window) | Reuses the chase | The follow-up window is per organization in calendar days and repeats; owner-pending items are PR states, not necessarily desk items; changing the follow-up rule risks the existing 3-day behaviour |
| C. In-memory `setTimeout` | Trivial | Lost on restart (card requires persistence) |

### 3.2 What the reminder is

| Option | For | Against |
|---|---|---|
| Push only | Smallest | Skipped in quiet hours or with no device: the owner might never "see a reminder" (AC1) |
| Desk alert addressed to the owner **and** one push (recommended) | Visible on every device (desktop, phone PWA) on the Desk, survives quiet hours; the push is the nudge, as in the 3-day pattern | One extra desk item, closed automatically when the owner acts |

### 3.3 Working day

| Choice | Decision |
|---|---|
| Days | Monday to Friday. Saturday and Sunday never count. |
| Holidays | **Not observed** in this card: a public holiday on a weekday counts as a working day. The codebase has no holiday data and holidays depend on country and region; adding a calendar is a separate feature (backlog suggestion raised). The helper takes an optional `isHoliday(date)` predicate so a calendar can be added later without changing callers. |
| Time zone | The **owner's** time zone (`users.timezone`), else `UTC` when unset or invalid. It is resolved once at registration and stored on the timer, so a later time-zone change does not move a due time that is already set. |
| Counting rule | Working time is counted on the owner's wall clock. Start on a working day at local time *t*: due at local time *t* on the 2nd following working day. Start on a Saturday or Sunday: counting starts at Monday 00:00 local, so it is due at Wednesday 00:00 local (the end of Tuesday). The wall-clock time is kept across daylight-saving changes (`zonedWallToUtc`), plus the start's seconds and milliseconds. |

Examples (`UTC` unless named; n = 2):

| Start | Due |
|---|---|
| Mon 09:00 | Wed 09:00 |
| Thu 14:00 | Mon 14:00 |
| Fri 17:30 | Tue 17:30 |
| Sat 10:00 | Wed 00:00 |
| Sun 23:59 | Wed 00:00 |
| Fri 23:30 Africa/Johannesburg (Fri 21:30 UTC) | Tue 23:30 Johannesburg |
| Fri 2026-10-23 10:00 Europe/London (BST) | Tue 2026-10-27 10:00 GMT (wall clock kept over the change) |

### 3.4 How size exceptions are kept out (AC3)

| Option | Decision |
|---|---|
| The kind enum lists only the three owner-pending kinds; `size_exception` is not one of them, so `registerOwnerPending` refuses it (zod parse error) and the sweep can never see one | **Recommended.** GWP-210 builds its own lapse (it depends on this card for the working-day helper). If GWP-210's designer wants to reuse the table, the sweep dispatches on a per-kind policy (`remind` here); GWP-210 may add a kind with policy `lapse` and its own handler, which still sends no reminder. That is GWP-210's decision. |

## 4. Recommendation and design

Option A, desk alert plus one push, Mon-Fri in the owner's time zone with no holidays, due time persisted, at most one reminder.

### 4.1 Shared (`packages/shared`)

**New `packages/shared/src/time/working-days.ts`** (+ `time/index.ts`, exported from `src/index.ts`):

```ts
export const WORKING_WEEKDAYS = [1, 2, 3, 4, 5] as const; // ISO: Mon..Fri
/** Is the local calendar date (`YYYY-MM-DD`) a working day? Weekends never; `isHoliday` (optional) can remove more. */
export function isWorkingDate(date: string, isHoliday?: (date: string) => boolean): boolean;
/**
 * The instant `n` working days after `start` on the wall clock of `tz` (invalid or empty tz: UTC).
 * Start on a non-working day: counting starts at 00:00 of the next working day.
 */
export function addWorkingDays(start: Date, n: number, tz: string | null | undefined,
  opts?: { isHoliday?: (date: string) => boolean }): Date;
```

Sketch (the builder writes the real code):

```ts
let { date, minutes } = localParts(start, zone);          // reporter/index.ts
let keepMs = start.getTime() % 60_000;                     // seconds + ms
if (!isWorkingDate(date, h)) { date = nextWorkingDate(date, h); minutes = 0; keepMs = 0; }
for (let i = 0; i < n; i++) date = nextWorkingDate(date, h);
return new Date(zonedWallToUtc(date, hhmm(minutes), zone).getTime() + keepMs); // video/schedule.ts
```

`n` must be an integer >= 1 (throw otherwise). Pure; no clock read.

**New `packages/shared/src/review/owner-pending.ts`** (or `owner-pending/index.ts`; exported from `src/index.ts`):

```ts
export const OWNER_PENDING_KINDS = ['second_timeout', 'manual_trigger', 'over_cap_spend'] as const;
export const OwnerPendingKindSchema = z.enum(OWNER_PENDING_KINDS);
export type OwnerPendingKind = z.infer<typeof OwnerPendingKindSchema>;
/** Size exception requests lapse without a reminder (separate timer); they are never an owner-pending kind. */
export const OWNER_PENDING_REMINDER_WORKING_DAYS = 2;
export const OWNER_PENDING_KIND_LABEL: Record<OwnerPendingKind, string> = {
  second_timeout: 'timed out twice and waits for your decision',
  manual_trigger: 'waits for you to start a review by hand',
  over_cap_spend: 'is over the daily review limit and waits for your approval of extra spend',
};
export const RegisterOwnerPendingSchema = z.object({
  kind: OwnerPendingKindSchema,
  orgId: z.uuid(),
  projectId: z.uuid().optional(),
  cardId: z.uuid().optional(),
  /** The item in the owning feature (a PR, a card + PR number): opaque to the timer. */
  subjectId: z.string().min(1).max(200),
  ownerUserId: z.uuid(),
  /** Shown on the reminder ("PR #42: add login"); no secrets, no content. */
  title: z.string().min(1).max(200),
  /** Same-origin path the reminder opens (the item's page); default `/desk`. */
  url: z.string().startsWith('/').max(400).optional(),
  startedAt: z.date(),
});
/** The pure rule (unit-tested): remind once when due and still open. */
export function ownerPendingAction(t: { status: 'open' | 'resolved'; dueAt: Date; remindedAt: Date | null }, now: Date): 'remind' | null;
export function ownerPendingReminderText(i: { title: string; kind: OwnerPendingKind }): { title: string; body: string };
```

Reminder text: title "Still waiting for you: <title>", body "<title> <kind label> for 2 working days. It stays not reviewed until you act." (Plain wording, no AI/agent wording.)

**New `packages/shared/src/events/owner-pending.ts`**, spread into `events/index.ts`; new stream helper `streamId.ownerPending(id) => \`owner-pending-${id}\`` in `ids.ts`:

```ts
defineEvent('OwnerPendingRegistered', z.object({
  timerId: Id, kind: OwnerPendingKindSchema, orgId: Id, projectId: Id.optional(), cardId: Id.optional(),
  subjectId: z.string().min(1).max(200), ownerUserId: Id, title: z.string().min(1).max(200),
  url: z.string().max(400).optional(), startedAt: IsoDate, dueAt: IsoDate, timezone: z.string().max(64),
})),
defineEvent('OwnerPendingReminded', z.object({
  timerId: Id, firedFor: IsoDate /* = dueAt */, deskItemId: Id, recipients: z.array(Id),
})),
defineEvent('OwnerPendingResolved', z.object({
  timerId: Id, reason: z.enum(['owner_acted', 'closed']), by: Id.optional(),
})),
```

Scope: `projectScope(orgId, projectId)` when there is a project, else `orgScope(orgId)`.

### 4.2 Server (`apps/server`)

**Migration `apps/server/migrations/2900_owner_pending.sql`** (projection, rebuilt from the log; no foreign keys, as in `2840_journey_waits.sql`):

```sql
CREATE TABLE IF NOT EXISTS owner_pending_timers (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL,
  project_id     uuid,
  card_id        uuid,
  kind           text NOT NULL,
  subject_id     text NOT NULL,
  owner_user_id  uuid NOT NULL,
  title          text NOT NULL,
  url            text,
  timezone       text NOT NULL,
  started_at     timestamptz NOT NULL,
  due_at         timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'open',   -- 'open' (owner-pending, not reviewed) | 'resolved'
  reminded_at    timestamptz,
  desk_item_id   uuid,
  resolved_at    timestamptz,
  resolution     text,
  resolved_by    uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS owner_pending_open ON owner_pending_timers (kind, subject_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS owner_pending_due ON owner_pending_timers (due_at) WHERE status = 'open' AND reminded_at IS NULL;
```

**Projector `apps/server/src/projections/owner-pending.ts`** (register it in `projections/index.ts` and add `'owner_pending_timers'` to `PROJECTION_TABLES`; add `DELETE FROM owner_pending_timers WHERE project_id=$1` next to the `journey_waits` delete in `projections/projects.ts` line 119):

- `OwnerPendingRegistered`: `INSERT ... ON CONFLICT DO NOTHING`.
- `OwnerPendingReminded`: `UPDATE ... SET reminded_at = e.createdAt, desk_item_id = $deskItemId WHERE id=$1 AND status='open' AND reminded_at IS NULL AND due_at = $firedFor` (replay and double-fire safe).
- `OwnerPendingResolved`: `UPDATE ... SET status='resolved', resolved_at, resolution, resolved_by WHERE id=$1 AND status='open'`.

**Commands `apps/server/src/commands/owner-pending.ts`**:

```ts
/** Called by the feature that puts an item into an owner-pending state, inside its own append transaction. Idempotent: an open timer for the same kind+subject is returned unchanged (the clock is not restarted). */
export async function registerOwnerPending(ctx: Ctx, tx: Tx, input: RegisterOwnerPending): Promise<{ timerId: string; dueAt: Date; created: boolean }>;
/** Called by the owning feature whenever the owner acts on the item (manual trigger, approve/decline extra spend, decide after a second timeout) or the item stops being owner-pending (PR closed or merged). Cancels the timer and closes the reminder alert if one was raised. No-op when nothing is open. */
export async function resolveOwnerPending(ctx: Ctx, tx: Tx, r: { kind: OwnerPendingKind; subjectId: string; reason: 'owner_acted' | 'closed'; byUserId?: string }): Promise<boolean>;
/** Read model for the owning feature's UI ("Reminded" badge). */
export async function ownerPendingOf(db: Queryable, kind: OwnerPendingKind, subjectId: string): Promise<{ timerId: string; status: 'open' | 'resolved'; dueAt: string; remindedAt: string | null } | null>;
/** Scheduler pass. */
export async function ownerPendingSweep(ctx: Ctx): Promise<{ reminded: number }>;
```

`registerOwnerPending`:
1. `RegisterOwnerPendingSchema.parse(input)` (refuses any other kind, including `size_exception`: AC3);
2. `pg_advisory_xact_lock(hashtext('owner-pending:' || kind || ':' || subjectId))`, then select the open row for kind+subject; if one exists return it (`created: false`);
3. `tz = userTimezone(tx, ownerUserId)` (`users.timezone` if `isValidTimeZone`, else `'UTC'`);
4. `dueAt = addWorkingDays(startedAt, OWNER_PENDING_REMINDER_WORKING_DAYS, tz)`;
5. append `OwnerPendingRegistered` on `streamId.ownerPending(newId)` with `{ tx }`.

`resolveOwnerPending`: lock as above, `SELECT ... WHERE kind=$1 AND subject_id=$2 AND status='open' FOR UPDATE`; append `OwnerPendingResolved`; if `desk_item_id` is set, close that alert in the same transaction (`closeDeskItemIn` from `desk-port.ts` with resolution `acknowledged` when a user acted, or append a system `DeskItemResolved` as `closeDeskNotice` does when there is no user).

`ownerPendingSweep` (copy the `followUpSweep` shape):
1. `now = ctx.clock.now()`; candidates: `SELECT t.id FROM owner_pending_timers t JOIN organizations o ON o.id=t.org_id AND o.status IN ('trial','active') WHERE t.status='open' AND t.reminded_at IS NULL AND t.due_at <= $1 ORDER BY t.due_at LIMIT 500`.
2. Per candidate, `withAppendTx`: advisory lock `owner-pending-timer:<id>`, re-read the row; `ownerPendingAction(row, now)`; if `'remind'`: append in one transaction a `DeskItemCreated` (kind `alert`, subkind `owner_pending_reminder`, `blocking:false`, `pinned:false`, `addresseeUserId: owner`, `projectId`/`cardId` when known, `subjectKey: 'owner-pending:<timerId>'`, `data: { timerId, kind, subjectId, url }`, title/body from `ownerPendingReminderText`) and `OwnerPendingReminded { firedFor: due_at }`.
3. After commit: `notifyUsers(ctx, [owner], { category: 'follow_ups', subject: timerId, state: 'owner-pending-reminder', title, body, url: row.url ?? '/desk#desk-item-<id>', priority: 'normal', orgId })`, errors logged, as in `followUpSweep`.
4. The sweep never appends anything to the owning item's stream and never changes `status`: the item stays owner-pending ("not reviewed").

**Scheduler**: in `scheduler/scheduler.ts`, after the `followUpSweep` line: `await ownerPendingSweep(this.ctx).catch((err) => this.ctx.log.error({ err }, 'owner-pending reminders failed'));`.

No HTTP route is needed in this card: the reminder is a desk item (existing desk UI renders alerts with any subkind and lets the owner dismiss it). The owning features add their own actions and call `resolveOwnerPending`.

### 4.3 How the sibling cards use it

- GWP-209 (second timeout within budget): when the PR stays "not reviewed" after the second timeout, `registerOwnerPending(ctx, tx, { kind: 'second_timeout', subjectId, ownerUserId, title, url, startedAt: ctx.clock.now(), ... })`; when the owner decides the next step, `resolveOwnerPending(... 'owner_acted')`.
- GWP-200/201 (daily cap, manual trigger): `over_cap_spend` / `manual_trigger` in the same way; a manual trigger by the owner is the resolving action.
- GWP-210 (size exception): does **not** register here. It reuses `addWorkingDays` for its lapse and sends no reminder.
- Who the owner is (project owner, card owner) is decided by the registering card; the timer takes one `ownerUserId`.

### 4.4 Docs

- `docs/USER-GUIDE.md`, right after the **Reminders for open items** paragraph (line 729), a new paragraph, for example: "**Reminders for items waiting on you.** A pull request that waits for you (it timed out twice and is within its size budget, it waits for you to start a review by hand, or it needs your approval to spend past the daily review limit) reminds you once when you have not acted for **2 working days**. Working days are Monday to Friday in your own time zone (set under your profile; UTC if none); public holidays are not skipped. You get a notification (category **Reminders for open items**) and a reminder on your Desk. Nothing else changes: the pull request stays **not reviewed** until you act, and acting on it removes the reminder. A size exception request is different: it lapses after 2 working days with no reminder."
  Follow the guide's existing style and keep it device-neutral (the Desk is the same on phone and desktop).
- `docs/ARCHITECTURE.md`: a short new section (45) "Owner-pending timers": events, table, sweep, working-day rule, and that it never writes the item's state. Link this report.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Double reminder (two servers, repeated sweep, replay) | Advisory lock + re-read in the transaction; projector guard `reminded_at IS NULL AND due_at = firedFor`; push dedupe per subject+state in `notifyUsers`. |
| Server down at the due time | The due time is persisted; the first sweep after boot reminds (late, once). |
| Owner time zone invalid or unset | `isValidTimeZone` check, `UTC` fallback, stored on the timer. |
| Daylight-saving shifts | Wall-clock arithmetic via `zonedWallToUtc`; a test covers one change. |
| Holiday on a weekday is counted | Documented in the guide; `isHoliday` hook for a later calendar; backlog suggestion raised. |
| The reminder alert itself gets chased by the 3-day follow-up | `alert` is not in `FOLLOW_UP_KINDS`. |
| Sibling cards forget to resolve | The register/resolve contract is in the ARCHITECTURE section and in this report; resolve is a no-op when nothing is open, so calling it on every owner action is safe. |
| Projection rebuild | Table added to `PROJECTION_TABLES`; all state comes from events. |

## 6. Acceptance criteria mapped to the design and tests

New test files only (the card's rule):

- `packages/shared/test/working-days.test.ts` (pure unit): the examples table in 3.3 (weekday start, Thu/Fri across the weekend, Saturday and Sunday starts, a Johannesburg start, the Europe/London DST change, invalid time zone falls back to UTC, `n` < 1 throws, `isHoliday` hook skips a date).
- `packages/shared/test/owner-pending.test.ts` (pure unit): `ownerPendingAction` returns `'remind'` only when open, due and not reminded; `null` before due, after a reminder, and when resolved; `RegisterOwnerPendingSchema` refuses `size_exception`.
- `apps/server/test/owner-pending.test.ts` (server test, needs the test Postgres like `follow-up.test.ts`; mock `web-push` the same way). Pin the clock with `w.t.clock.setOffset(Date.parse(iso) - Date.now())` and pass `startedAt` explicitly.

| AC | Design | Test |
|---|---|---|
| AC1: untouched for 2 working days, the owner sees a reminder and the state is unchanged | `addWorkingDays` due time; sweep raises one desk alert to the owner and one push; the timer row stays `status='open'`; nothing is appended to the item | Register on **Friday 15:00 UTC**; clock to Monday 15:00, sweep: no reminder (only 1 working day). Clock to Tuesday 15:00, sweep: one `owner_pending_reminder` desk alert addressed to the owner, one push (category `follow_ups`), `OwnerPendingReminded` once, row still `open` with `resolved_at` null. Sweep again (and Wednesday): no second reminder. Second case: register on **Saturday 10:00**, due **Wednesday 00:00**; Tuesday 23:59 nothing, Wednesday 00:00 reminded. Restart safety: register, then rebuild projections (or create a fresh sweep run) and check the due time is unchanged. |
| AC2: owner acts within 2 working days, no reminder | `resolveOwnerPending` sets `status='resolved'`; sweep only picks `open` rows | Register Monday 09:00, `resolveOwnerPending(... 'owner_acted')` Tuesday; clock to Thursday, sweep: no desk alert, no push, no `OwnerPendingReminded`. Also: resolve after a reminder closes the reminder alert. |
| AC3: size exception, no reminder from this timer | Kind enum excludes `size_exception`; `registerOwnerPending` parses with the schema | `registerOwnerPending({ kind: 'size_exception', ... })` rejects; no row exists; after 2 working days the sweep sends nothing. |

Existing behaviour to re-run (Likely regression order): `apps/server/test/follow-up.test.ts` (the reminder alert must not be chased; same push category), `apps/server/test/agent-ux-rebuild.test.ts` and any projection-rebuild test (new table in `PROJECTION_TABLES`), `packages/shared/test/events.test.ts` (new event types).

## 7. Out of scope

Holiday calendars (backlog suggestion), the PR states and their UI (GWP-197 to GWP-201, GWP-209), the size exception lapse (GWP-210), a separate push category or settings for this reminder.
