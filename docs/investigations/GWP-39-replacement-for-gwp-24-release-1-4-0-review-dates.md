# Review dates for decisions and standing orders (release 1.4.0)

## Question

Each ledger entry (decision, requirement or standing order; organization-wide or project) should be able to carry an
optional review date. The owner sees which entries are due, confirms, edits or retires them, and the CEO raises due
entries with the owner. A passed date never retires, hides or unbinds an entry.

This design is checked against the current code of this repository. The earlier design for the same feature lives on a
branch of another repository that cannot be read from here, and its card was still at spec/draft. So this design
follows this card's requirements and acceptance criteria, which carry the earlier spec over. The differences that come
from the code are listed under "Differences and limits" below.

## Findings (current code)

- **The ledger is event-sourced.** Events are in `packages/shared/src/events/ledger.ts` (`LedgerEntryAdded`,
  `LedgerEntryEdited`, `LedgerEntrySuperseded`, `LedgerEntryRetired`, `LedgerEntryFlagged`). Projections are in
  `apps/server/src/projections/ledger.ts` and write `ledger_entries` (plus `ledger_entry_versions` for edits). No other
  registry lists event types, so a new ledger event needs only the schema and a projector.
- **Writes:** `apps/server/src/commands/ledger.ts`.
  - `addLedgerEntryChecked` checks permissions. A project standing order needs the project owner. An org-wide entry
    needs the org Owner or an Admin. A project decision or requirement can be added by any member of the project.
  - `editLedgerEntry` only accepts **standing orders** (`409 not_editable` otherwise). Every edit voids full-power
    authority (`voidAuthorityEvents`) and bumps `version`.
- **Retire:** `apps/server/src/commands/ledger-retire.ts`. `retireLedgerEntry` allows the project owner for project
  entries and the org Owner or an Admin for org-wide entries. This is the "manage" rule, and `withCanEdit` in
  `queries/ledger.ts` turns the same rule into `canRetire` on the DTO.
- **Routes:** `apps/server/src/routes/ledger.ts`: `GET/POST /api/ledger`, `PATCH /api/ledger/:id`, `POST
  /api/ledger/:id/retire|authorize|revoke|escalate`, `GET /api/ledger/:id/history`.
- **DTOs and requests:** `packages/shared/src/api/ledger.ts`. The DTO fields added later use `.default(...)`, so older
  fixtures still parse.
- **Reads:** `apps/server/src/queries/ledger.ts`. `standingOrdersFor` and `standingOrdersForProjects` (what agents
  are given) filter only on `superseded_by IS NULL AND retired_at IS NULL`. `listLedger`, `getLedgerDto` and
  `getVisibleLedgerDto` build the DTO through `toLedgerDto` and `withCanEdit`. All of them are called only from the
  ledger routes.
- **Vault copy:** `apps/server/src/commands/decisions.ts`.
  - `registerDecisionHook` appends a new standing order to `standing-orders.md` (`appendStandingOrder`, `append`
    mode). On `LedgerEntryEdited` it rewrites the scope's whole file from the ledger (`rewriteStandingOrders`,
    `replace` mode).
  - Decision files (`decisions/<date>-<slug>.md`, `create` mode) are written only for questions the owner answered.
    Decisions added through `POST /api/ledger` get no vault file. The file path is on `ledger_entries.vault_path`.
  - The two standing-order renderers repeat the same block format: `\n## title\n\nbody\n\n_Added YYYY-MM-DD._\n`.
- **CEO brief:** `apps/server/src/ceo/brief.ts`. `buildCeoBrief` (wake and review, line ~202) and `buildOwnerBrief`
  (owner chat, line ~292) both add `ordersBriefSection` (`apps/server/src/ceo/orders.ts`). Text that comes from the
  ledger goes through `renderCeoData` (`packages/shared/src/prompt/untrusted.ts`).
- **Clock:** server code gets the time from `ctx.clock.now()` (`apps/server/src/clock.ts`), and tests can shift it.
- **Dates:** `pg` parses a `date` column into a JS `Date` at local midnight (`db/pool.ts` sets a parser only for int8).
  So a date must be read as `::text`, as `hr/metrics.ts` does. On the web, `formatDate('2026-10-30')` reads the
  string as UTC midnight and shows the day before in timezones behind UTC. `z.iso.date()` already exists in the
  codebase (`api/board.ts`).
- **Web:**
  - `apps/web/src/pages/Ledger.tsx` holds `Entry`, `EditForm` (standing orders only), `RetireForm` and the filter chips.
  - `apps/web/src/components/LedgerForm.tsx` is used by the Ledger page and `pages/Desk.tsx`.
  - Hooks are in `apps/web/src/api/queries/ledger.ts`.
  - The existing unit test is `apps/web/src/test/ledger-edit.test.tsx`.
- **Tests:** every server test in `apps/server/test` needs the test Postgres (`vitest.config.ts` globalSetup, port
  5433). The pure unit tests are in `packages/shared/test` and `apps/web/src/test`. No e2e spec covers the Ledger page
  alone (`e2e/tests/desk.spec.ts` touches `/ledger`). Builders cannot edit `e2e/**`, so the Playwright part of the
  test plan goes to the tester.

## Options

### A. Where the review date lives in the event stream

| Option | For | Against |
|---|---|---|
| A1: put `reviewDate` on `LedgerEntryEdited` | one event type | Edited is for standing orders only, it bumps the version, it writes a history row, and the command voids full power. A date change would void the CEO's authority and add a fake "version". Decisions cannot be edited at all. |
| **A2: optional `reviewDate` on `LedgerEntryAdded` plus a new `LedgerEntryReviewDateSet` event** | Works for every scope. Leaves wording, version and authority alone. A date change is visible in the event log. Old events replay to NULL. | one more event type and projector |

**Choice: A2.**

### B. Where "due" is computed

| Option | For | Against |
|---|---|---|
| B1: `CURRENT_DATE` in SQL | short | Depends on the database session's timezone, and tests cannot shift it with `ctx.clock`. The DTO and the brief would need the same SQL in several places. |
| B2: computed in the web | none | the card forbids it |
| **B3: one pure function `isReviewDue(reviewDate, today)` and one `ledgerToday(now)` (UTC calendar date of `ctx.clock.now()`), called only by the server** | One place. Testable without a database. Follows `ctx.clock`. SQL filters get `today` as a `$n::date` parameter from the same function. | `today` has to be passed into the queries |

**Choice: B3.** The date is the server's UTC date, which matches how the vault already stamps `_Added YYYY-MM-DD._`
(`toISOString().slice(0, 10)`).

### C. Who may set or change a date

| Option | For | Against |
|---|---|---|
| **C1: at creation, whoever may create the entry. Afterwards (change, clear, confirm), the retire/"manage" rule: project owner, or org Owner or Admin** | Reuses `retireLedgerEntry`'s check unchanged. Matches `canRetire` on the DTO. No new permission model. | A project member who adds a decision can give it a date at creation, but cannot change it later. This is the same asymmetry as retire today. |
| C2: the edit rule from `editLedgerEntry` | none | `editLedgerEntry` lets any project member through for project decisions before it refuses them with not_editable, so it is not a manage check |

**Choice: C1.**

### D. Vault copy of a decision's review date

| Option | For | Against |
|---|---|---|
| D1: re-render the whole decision file (`replace`) | clean file | The server must rebuild the full `DecisionRecord` from the desk item. That is heavy and fragile. |
| D2: `section` mode block | idempotent | `applyManagedSection` puts the block before the first `- ` line, which can land in the middle of an answer that holds a list |
| **D3: append one line per change** (`append` mode, already used for standing orders) | Simple and robust. The file reads as a log of reviews. | the file grows by one line per change |

**Choice: D3** for decision files. For `standing-orders.md` the file is already rewritten from the ledger, so the
date simply becomes part of each block.

## Recommendation and design

### Data: migration `apps/server/migrations/2750_ledger_review_date.sql`

```sql
-- Review dates on ledger entries (release 1.4.0). Optional calendar date; existing entries keep NULL and behave as
-- before. reviewed_at is set when the owner confirms a due entry. Projection of LedgerEntryAdded.reviewDate and
-- LedgerEntryReviewDateSet. Safe to run again.
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS review_date date,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
CREATE INDEX IF NOT EXISTS ledger_entries_review_due ON ledger_entries (org_id, review_date)
  WHERE review_date IS NOT NULL AND retired_at IS NULL AND superseded_by IS NULL;
```

The columns are nullable with no default. Adding them only changes table metadata in Postgres, so it is safe on a
populated table, and existing rows come out NULL. If GWP-31 lands a migration first, take the next free number and do
not reuse one.

### Shared: `packages/shared`

`events/ledger.ts`:

```ts
/** A calendar date, YYYY-MM-DD (no time, no zone). */
export const CalendarDate = z.iso.date();

// LedgerEntryAdded payload: add
      /** Optional date the owner wants to look at this entry again (release 1.4.0). */
      reviewDate: CalendarDate.optional(),

// new event
  /**
   * The review date of an entry was set, changed or cleared (`reviewDate: null`). `confirmed`: the owner reviewed a due
   * entry and kept it (with a new date or none). Wording, version and full-power authority are not touched.
   */
  defineEvent(
    'LedgerEntryReviewDateSet',
    z.object({ entryId: Id, reviewDate: CalendarDate.nullable(), confirmed: z.boolean().default(false) }),
  ),
```

`api/ledger.ts`:

- `LedgerEntryDtoSchema`: add `reviewDate: CalendarDate.nullable().default(null)`, `reviewDue:
  z.boolean().default(false)` ("computed by the server: live, has a date, and the date is today or earlier") and
  `reviewedAt: IsoTime.nullable().default(null)`. Keep the defaults so the web test fixtures still parse.
- `CreateLedgerEntryRequestSchema`: add `reviewDate: CalendarDate.optional()`.
- `EditLedgerEntryRequestSchema`: add `reviewDate: CalendarDate.nullable().optional()` (null clears it). Extend the
  refine to `... || v.reviewDate !== undefined` and change its message to "give a new title, text, tags or review
  date".
- New `ReviewLedgerEntryRequestSchema = z.object({ reviewDate: CalendarDate.nullable() })` for `POST
  /api/ledger/:id/review` (confirm).
- `LedgerQuerySchema`: add `due: z.enum(['true', 'false']).optional()` (only entries due for review).
- Pure helpers, used by the server only. The web must not call them:

```ts
/** The server's calendar date (UTC) for review dates: the one "today" the ledger uses. */
export const ledgerToday = (now: Date): string => now.toISOString().slice(0, 10);
/** Due for review: the entry is live and its date is today or earlier (YYYY-MM-DD strings compare as dates). */
export const isReviewDue = (e: { reviewDate: string | null; retired?: boolean; superseded?: boolean }, today: string) =>
  !!e.reviewDate && !e.retired && !e.superseded && e.reviewDate <= today;
```

`vaults/index.ts`: one renderer for a standing-order block, used by both the append and the rewrite paths:

```ts
export function renderStandingOrderBlock(o: { title: string; body: string; addedDay: string; reviewDate?: string | null }) {
  return `\n## ${o.title.trim()}\n\n${o.body.trim()}\n\n_Added ${o.addedDay}._\n${o.reviewDate ? `_Review by ${o.reviewDate}._\n` : ''}`;
}
```

With no date the output is byte-for-byte what the code writes today. A unit test must check that.

### Server

**Projections** (`projections/ledger.ts`):

- `LedgerEntryAdded`: insert `review_date = p.reviewDate ?? null`.
- New `LedgerEntryReviewDateSet`:
  `UPDATE ledger_entries SET review_date=$2::date, reviewed_at=CASE WHEN $3 THEN $4 ELSE reviewed_at END WHERE id=$1`.

**Commands:** new file `apps/server/src/commands/ledger-review.ts`. Keep the edits in `ledger.ts` small, because GWP-31
also changes it.

- Move the permission block of `retireLedgerEntry` into an exported
  `assertCanManageEntry(db, userId, e: { org_id; project_id })` in `ledger-retire.ts`. `retireLedgerEntry` calls it,
  with the same messages and behaviour. Then `ledger-review.ts` imports it.
- `reviewDateEvents(e, reviewDate, opts: { confirmed: boolean; today: string; actor })` is pure over the loaded row
  and returns `AppendInput[]`:
  - A retired entry gives `409 retired`. A superseded entry gives `409 superseded`.
  - A date before `today` gives **`400 review_date_past`** ("the review date is in the past; pick today or a later
    date").
  - When `confirmed`:
    - the entry must be due: `409 not_due` ("this entry is not due for review").
    - a new date must be **after** today: `400 review_date_past` ("pick a date after today, or no date"), so the
      marker disappears.
  - It returns `[]` when not confirming and the date is unchanged. Compare against the row's `review_date::text`.
- `setLedgerReviewDate(ctx, user, entryId, { reviewDate, confirmed })`:
  - `withAppendTx`, then `SELECT *, review_date::text AS review_date_text FROM ledger_entries WHERE id=$1 FOR UPDATE`.
  - `notFound` when missing, then `assertCanManageEntry`, then `reviewDateEvents(...)`, then `ctx.store.append`.
  - Returns whether anything was written.
- `addLedgerEntryChecked` (`ledger.ts`):
  - Check `req.reviewDate` against `ledgerToday(ctx.clock.now())`: `400 review_date_past`. Do this before the
    duplicate check, so a bad date never merges.
  - Add `...(req.reviewDate ? { reviewDate: req.reviewDate } : {})` to the `LedgerEntryAdded` payload.
  - **Merge path:** when the request merges into an existing order and carries a date, pass `reviewDate` on to the
    `editLedgerEntry` call. The date then lands on the kept entry.
- `editLedgerEntry` (`ledger.ts`): add only what is needed.
  - `const wording = req.title !== undefined || req.body !== undefined || req.tags !== undefined;`
  - Keep the existing scope, retired and superseded checks inside `if (wording)`.
  - When `req.reviewDate !== undefined`:
    - call `assertCanManageEntry(tx, user.id, e)`. For standing orders this is the same rule as today. For decisions it
      is the retire rule.
    - push `reviewDateEvents(...)` into the same `events` array.
  - Only `LedgerEntryEdited` voids authority. The date event never does.
  - Return false when both parts are empty.

  Route: `PATCH /api/ledger/:id` then handles `{ reviewDate }` alone for a decision too. An alternative is for the
  route to call `setLedgerReviewDate` when no wording field is given. Pick one and test it. The first keeps a single
  transaction for a mixed edit.

**Routes** (`routes/ledger.ts`):

- `POST /api/ledger/:id/review` (body `ReviewLedgerEntryRequestSchema`) calls
  `setLedgerReviewDate(..., { confirmed: true })` and returns `{ entry }`.
- `POST /api/ledger` and `PATCH` gain nothing beyond the schema changes.

**Queries** (`queries/ledger.ts`):

- `DTO_SELECT`: add `e.review_date::text AS review_date_text`. Do not use `r.review_date`, because it is a local-midnight
  `Date`.
- `toLedgerDto(r, today, rank?)`:
  - `reviewDate: r.review_date_text ?? null`
  - `reviewedAt: iso(r.reviewed_at) ?? null`
  - `reviewDue: isReviewDue({ reviewDate: r.review_date_text, retired: !!r.retired_at, superseded: !!r.superseded_by }, today)`
- `listLedger(db, userId, orgId, o)`: `o` gains `today: string` and `due?: string`.
  - Non-search SQL: add `AND (NOT $6::boolean OR (e.review_date IS NOT NULL AND e.review_date <= $7::date AND e.retired_at IS NULL AND e.superseded_by IS NULL))`.
  - Search path: filter the mapped DTOs with `e.reviewDue`.
  - Sort order is unchanged.
- `getLedgerDto(db, id, today, userId?)` and `getVisibleLedgerDto(db, userId, id, today)`. The routes pass
  `ledgerToday(ctx.clock.now())`. These are the only callers, which grep confirms.
- New `dueForReview(db, orgId, today, limit = 20)`: live entries of the org with `review_date <= $today`, ordered by
  `review_date, created_at, id`. Columns: `id, scope, title, body, review_date::text, project key`.
- **Leave `standingOrdersFor`, `standingOrdersForProjects`, `searchLedger` and `cardLedgerEntries` unchanged.** A
  passed date does not filter anything. `packages/shared/src/prompt/standing-orders.ts`
  (`renderBindingStandingOrders`) stays unchanged too. How agents receive standing orders does not change.

**CEO brief:** new file `apps/server/src/ceo/review-due.ts`.

```ts
export async function reviewDueBriefSection(db: Queryable, orgId: string, today: string): Promise<string | undefined> {
  const due = await dueForReview(db, orgId, today);
  if (!due.length) return undefined;
  const lines = due.map((e) =>
    `- ${scopeWord(e.scope)} ${e.id} (${e.project_key ? `project ${e.project_key}` : 'every project'}), review date ${e.review_date}: ${oneLine(e.title, 120)}: ${oneLine(e.body, 240)}`);
  return [
    '## Ledger entries due for review',
    'The owner set a review date on these and it has come. They still bind agents until the owner retires them. Raise them with the owner (`aom ceo notify --kind needs_you`, naming the entry); do not retire or change an entry because its review date passed.',
    renderCeoData('Entries due for review (text from the ledger)', lines.join('\n')),
  ].join('\n');
}
```

Add it right after the `ordersBriefSection` push in `buildCeoBrief` (both wake and review) and in `buildOwnerBrief`,
with `ledgerToday(ctx.clock.now())`. No section appears when nothing is due, the same as the orders section. Add no new
wake reason: due entries show up in the next brief.

**Vault** (`commands/decisions.ts`):

- `appendStandingOrder` input gains `reviewDate?: string | null`. Its content comes from `renderStandingOrderBlock`.
  The hook passes `p.reviewDate` from `LedgerEntryAdded`.
- `rewriteStandingOrders` selects `review_date::text AS review_date` as well and renders through
  `renderStandingOrderBlock`.
- `registerDecisionHook` gets a new branch for `LedgerEntryReviewDateSet`. Load `org_id, project_id, scope, vault_path`.
  - A standing order: `rewriteStandingOrders(ctx, { orgId, projectId })`.
  - Otherwise, when `vault_path` and `project_id` are set:
    - append one line to the decision file through `enqueueVaultWrite(ctx, ctx.pool, (await projectVault(...)).vaultId, { path: vault_path, mode: 'append', content, commitMessage: 'decision review date' })`.
    - the line: `\n_Review by ${d} (set ${day})._\n`, or `\n_Reviewed ${day}; next review ${d}._\n` / `_Reviewed ${day}; no further review date._` when confirmed, or `\n_Review date cleared ${day}._\n`.
    - `day` is `e.createdAt` as YYYY-MM-DD.
  - Do nothing when there is no vault (the same as today).
- Entries without a date: no write is triggered, and their blocks render exactly as before.

### Web

**Hooks** (`api/queries/ledger.ts`):

- `LedgerFilter.due?: boolean`, passed as `due: 'true'` and added to the `queryKey`.
- `useReviewLedgerEntry(id)` posts to `/ledger/${id}/review` and invalidates `['ledger']`.
- `useEditLedgerEntry` already takes `EditLedgerEntryRequest`, which now includes `reviewDate`.

**`components/LedgerForm.tsx`** (Ledger page and Desk):

- Add `<TextInput type="date" label="Review date (optional)" hint="Agents keep following it after this date; it is only marked for you to look at again." />`.
- Send `...(reviewDate ? { reviewDate } : {})`.
- When `add.error` is an `ApiError` with code `review_date_past`, show the message as the field's `error`, not only in
  `ErrorBox`.
- Clear the field on success.
- A native date input brings up the platform date picker on touch devices, and it needs no soft keyboard.

**`pages/Ledger.tsx`:**

- Header row of `Entry`:
  - when `e.reviewDate`: `<span data-testid="ledger-review-date">review {formatCalendarDate(e.reviewDate)}</span>`.
  - when `e.reviewDue`: `<Badge tone="amber"><span data-testid="ledger-review-due">Review due</span></Badge>`.
  - The web does **no** date math. It reads `reviewDue` from the DTO.
- Add `formatCalendarDate(d)` to `lib/time.ts`. It formats `YYYY-MM-DD` with `timeZone: 'UTC'`, so the day does not
  shift. Do not use `formatDate`.
- Actions, shown when `!retired && e.canRetire` (the manage rule):
  - **Review date** button (every scope) opens a dialog `ReviewDateForm` (mode `set`): a date input plus Save, and
    "Remove review date" when a date exists. It calls `PATCH /api/ledger/:id { reviewDate }`.
  - When `e.reviewDue`, a **Confirm** button opens `ReviewDateForm` (mode `confirm`): "Next review date (optional)"
    plus Confirm, and it calls `POST /review`. The existing **Edit** (standing orders) and **Retire** buttons stay next
    to it, so all three review choices sit together.
  - Errors show as a field error, the same as in `LedgerForm`.
- Filters: a `FilterChip` "Due for review" (`pressed={dueOnly}`) next to "Show retired". It sets `due: true`, counts
  in `filtered`, and is reset by "Clear filters".
- `EditForm` stays wording-only. That keeps the overlap with GWP-29, which renames labels in this file, small.

### Docs

- `docs/ARCHITECTURE.md` section 15 (ledger): review dates, the new event, `POST /api/ledger/:id/review`, the `due`
  filter, the rule that a passed date never unbinds an entry, and "today = server UTC date".
- Section ~734 (events list): add `LedgerEntryReviewDateSet`.
- `docs/USER-GUIDE.md` section 4.5: one short paragraph on review dates, the "Review due" marker and its filter, and
  the three choices.

## Risks and traps

1. **Date parsing:** read `review_date::text`, never the parsed `Date`. On the web, never pass the date string to
   `new Date()` without `timeZone: 'UTC'`.
2. **UTC "today":** an owner far west of UTC who picks their own "today" late in the evening gets `review_date_past`,
   because the server's date is already tomorrow. The message says what to do. A per-owner timezone would mean a second
   "today" and was left out on purpose: one place, per the card.
3. **Full power:** a date change must never void authority. Only `LedgerEntryEdited` does, so do not route date-only
   changes through it.
4. **Merge into a near-duplicate:** the date has to follow the merge (see `addLedgerEntryChecked`), or it is lost
   silently.
5. **Decision vault line before the file exists:** the decision file is created on `QuestionAnswered`, and the owner
   can only set a date later, so the append normally lands after the create. If no workstation is online, both stay
   queued in order.
6. **Overlaps:**
   - GWP-31 (same group, held) changes `addLedgerEntryChecked` and `liveOrdersFor`. Keep the date check to a few lines
     at the top of the transaction, and put new logic in `ledger-review.ts`.
   - GWP-29 renames UI labels in `Ledger.tsx`, `LedgerForm.tsx` and `Desk.tsx`. Keep the new strings in place, so a
     rename touches only literals.
   - GWP-29 is currently recorded as depending on GWP-24, not on this card.
7. **Server tests need Postgres** (port 5433, globalSetup). If the build shift cannot reach it, run the shared and web
   unit tests, and name the server suites for the tester.

## Differences and limits

- **Earlier design not checked.** The earlier design document could not be read: its repository is not reachable from
  this worktree, and its card is still at spec/draft. This design follows this card's spec, which carries the earlier
  spec and acceptance criteria. A question was raised to add the repository if the document matters.
- **"Edit" for a due decision.** Decisions cannot be reworded today (`editLedgerEntry` refuses them). So for a due
  decision, "edit" means changing its review date. Rewording a decision stays out of scope, as before: retire it, and
  name the entry that replaces it. Standing orders keep the full edit.
- **Decisions added through the form have no vault file today.** Only decisions from answered questions do. So the
  vault copy of a review date exists for standing orders (`standing-orders.md`) and for decisions that have a decision
  file. This card does not add vault files for form-added decisions.
- **Requirements (scope `feature`)** get the same review date. The card says "decision or standing order", and the same
  code path serves all three scopes at no extra cost.
- **Confirm needs a future date or none,** and is only allowed on a due entry. That way the marker disappears after a
  confirm, as the acceptance criterion requires.

## Acceptance criteria mapped to the design

| Acceptance criterion | Design | Test (builder unless noted) |
|---|---|---|
| A decision and a standing order can each be created with a review date (API and form); it is stored and returned | `CreateLedgerEntryRequest.reviewDate`, `LedgerEntryAdded.reviewDate`, projection, DTO `reviewDate`, `LedgerForm` date field | server `apps/server/test/ledger-review-date.test.ts` (new): POST both scopes, then GET. web `apps/web/src/test/ledger-review-date.test.tsx` (new): form sends `reviewDate`. Tester: Playwright via the Ledger page and the Desk |
| A date can be changed and cleared (API and form); recorded as an event | `PATCH reviewDate` (null clears), `LedgerEntryReviewDateSet`, `ReviewDateForm` (set) | server: PATCH change and clear, then assert the event rows in `events`. web: the dialog PATCHes |
| A past date is rejected (4xx, form shows it) | `400 review_date_past` in add, edit and confirm; field error in both forms | server: POST and PATCH with yesterday give 400. web: the error shows under the field |
| Entries from before the release have no date and behave as before | nullable columns, `reviewDue` false, no vault write | server: an entry without a date has `reviewDate: null, reviewDue: false`. The existing ledger-edit/retire/search/cleanup and ceo tests stay unchanged and pass. shared: `renderStandingOrderBlock` without a date equals the old string |
| Ledger page: marker when the date is today or earlier, date only when in the future; due filter | DTO `reviewDue` from `isReviewDue`; `due` query; marker and chip | shared: `isReviewDue` table (yesterday, today, tomorrow, retired, null). server: `?due=true` with `ctx.clock` shifted. web: marker and filter render from the fixtures |
| From a due entry: confirm with a new date or none, edit, or retire; after confirming the marker is gone | `POST /review` (confirmed), existing Edit and Retire next to Confirm | server: confirm, then `reviewDue` is false and `reviewed_at` is set; confirm on a non-due entry gives 409; retire a due entry. web: the Confirm dialog posts. Tester: Playwright confirm and retire |
| A standing order whose date passed is still binding | `standingOrdersFor` and `standingOrdersForProjects` unchanged | server: an order with a past date (shift the clock forward after creating) is still in `standingOrdersFor` |
| CEO brief lists due entries (scope, text, date); none when nothing is due | `reviewDueBriefSection` in `buildCeoBrief` and `buildOwnerBrief` | server: brief contains the section and lines; without due entries there is no section heading |
| Vault file shows the date when there is one, unchanged otherwise | `renderStandingOrderBlock`, rewrite on `LedgerEntryReviewDateSet`, decision append line | shared: renderer with and without a date. server: the queued `vault.write` content after setting a date |
| Visibility unchanged; set dates only on entries one may see and manage | `assertCanManageEntry` (the retire rule), the visible list query is unchanged | server: a project member without owner rights gets 403 on PATCH and confirm; another org's entry gives 404 |
| Differences from the earlier acceptance criteria are written on the card | section "Differences and limits" above, also posted as a card comment | n/a |

Migration on a populated database: server test that inserts entries, runs the app (the migration has already run in
globalSetup), and checks `review_date IS NULL` for them. Existing rows are untouched by `ADD COLUMN` without a default.
