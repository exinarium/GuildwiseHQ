# Design: the Interests page (one place to say "what I care about")

Oct 5, 2026 · status: built (Oct 6, 2026; see "Implementation status" at the end) · companion to `docs/SPEC.md` ("Research and feeds"), `docs/ARCHITECTURE.md` (referenced as §n) and `docs/design/phases.md` (style)

Today a manager's interests are scattered: one feed schedule per topic (`/schedules`), ad-hoc research cards, and a `taste.md` that only grows from digest ratings. This design adds one global **Interests** page across all feed and research projects. An interest is the single statement of a topic; it owns the feed schedule that scans for it, prefills research cards about it, carries explicit taste rules, and shows what came of it (scans, items, ratings, notes).

Note: other agents are editing code while this was written. Migration numbers `1300_` (transcripts, built) and `1300_`/`1400_` (phases design) are taken or reserved, so this feature was designed with `1500_`. **Built as `apps/server/migrations/1306_interests.sql`** (the next free number after the hygiene migration `1305_`); wherever this document says `1500_`, read `1306_`.

---

## 0. Decision summary

| Decision | Chosen | Rejected alternatives (one line each) |
| --- | --- | --- |
| Where interests live | New `interests` projection fed by `events/interest.ts` on stream `interest-<id>`; one row per topic, linked to at most one feed project and one research project | A field on `schedules`: research-only interests have no schedule, and a schedule is the mechanism, not the intent. A per-project list: the owner decided one global page. |
| Interest ↔ schedule | **The interest owns its schedule.** Interest commands append the `Schedule*` events in the same append; the scheduler is unchanged. A linked schedule is locked: `PATCH`/`DELETE /api/schedules/:id` answer 409 `schedule_managed_by_interest`; "Run now" stays allowed | Two-way sync (edit either side): two writers to one card template, ordering bugs and confusing "who wins". A new interest scheduler: duplicates `fireDueSchedules`, backoff and failure notices. |
| Link from schedule to interest | `schedules.interest_id` set by `ScheduleCreated.interestId` (new) or `ScheduleLinked{scheduleId, interestId \| null}` (adopt / unlink) | Re-using `ScheduleUpdated` with an optional `interestId`: replaying older `ScheduleUpdated` events without it would have to mean "unchanged", which makes the upsert projector ambiguous. |
| Which cards belong to an interest | `cards.interest_id` from `CardCreated.interestId` (new optional field): set by scheduled feed cards of a linked schedule and by "Research this". `ScheduleLinked` backfills `interest_id` on the schedule's earlier cards | Joining through `cards.schedule_id` only: research cards have no schedule, and an interest that moves to another feed project gets a new schedule. |
| One schedule per interest | An interest with a feed project always has exactly one feed schedule. "Manual only" cadence and "paused" both mean `enabled=false`; "Run now" uses the schedule's template | No schedule for manual interests: "Run now" would need a second template path. |
| "Research this" | The web dialog prefills from a shared helper and calls the existing `POST /api/cards` with a new optional `interestId` | A dedicated `POST /api/interests/:id/research`: duplicates card creation, specify and validation for no gain. |
| Explicit taste ("seed taste") | Stored on the site per **feed project** in `taste_seeds` (`TasteSeedSet` event), each rule optionally tagged with an interest. The server is the source of truth: it puts the rules into the curator's brief, and mirrors them into `taste.md` as a managed section through `vault.write` (new mode `section`). The runner strips the managed section from the `taste.md` it passes on, so rules never appear twice | Appending seed rules to `taste.md` like ratings: edits and deletions are impossible (append-only), and a rule edited twice would stay twice. A separate `taste-rules.md`: the owner wants them in `taste.md` alongside rating rules. Per-interest taste files: curators run per project and the seen-list is per project. |
| Merge of explicit and rating-derived rules | Explicit rules come first (managed section right under the header) and win on conflict; rating-derived lines keep appending below, unchanged. Curator instructions say so | Rewriting rating lines when an explicit rule contradicts them: the server cannot read the vault, and rating history should stay readable. |
| Who writes the vault | Unchanged: only the runner, through durable `vault.write` commands (§16.4) issued by the event hook in `commands/taste.ts` | Server-side git access: the site never holds vault content or credentials. |
| Adopting existing schedules | Explicit: a banner lists unlinked feed schedules; "Adopt" creates one interest per schedule (`InterestCreated{adoptedFrom}` + `ScheduleLinked`) without rewriting the template | Auto-adopt in the migration: migrations do not append events, and a rebuild would lose them. Auto-adopt at boot: surprising, and naming collisions need a human. |
| Inline "new feed project" | `POST /api/interests` accepts `newFeedProject {key, name, domain}`; the command appends `ProjectCreated` and then the interest and schedule in the same transaction | Two requests from the browser: a failure in the second leaves an empty project behind. |
| Per-interest stats | Computed at read time in `queries/interests.ts` from `schedules`, `cards`, `digest_items`, `research_publications` (indexed by `cards.interest_id`) | A stats projection: small data, and read-time queries cannot drift. |
| Authorization | View: active members of a linked project. Create / edit / pause / delete / adopt / taste rules: **owner of the feed project** (the same rule as schedules today) and an active member of the research project. Research this: any active member of the research project | Any member edits interests: would let a guest manager change the owner's schedules and `taste.md`, which the schedule rule forbids today. |

---

## 1. Concepts

- **Interest**: `name` (short label, also the feed topic and card title), `description` (markdown: angle, include/exclude, level; the primary statement of intent, already treated so by scouts and curators), `feedProjectId?`, `researchProjectId?` (at least one), `subCategory?`, `preferredSites[]`, `scan` (cadence: cron + timezone + window hours + max items + `manual`), `status` (`active` / `paused`).
- **Derived feed card template** (`interestCardTemplate(interest)` in `packages/shared/src/interests/index.ts`): `{title: name, cardType: 'feed', fields: {topic: name, description?, windowHours, preferredSites?, maxItems, subCategory?}}`.
- **Schedule enabled** = `status === 'active' && !scan.manual && feedProjectId != null`.
- **Default window**: derived from the cron when the manager does not set it (`defaultWindowHours(cron)`: hourly → 1, daily and weekdays → 24, weekly → 168, else 24; the Monday gap of a weekdays cadence is not modelled). The drawer shows the derived value as a placeholder.
- **Taste seed**: explicit rules for a feed project: `[{text, interestId | null}]`. Rules tagged with an interest only reach cards of that interest; untagged rules reach every card of the project.

---

## 2. Data model: migration `apps/server/migrations/1500_interests.sql`

```sql
-- Interests (docs/design/interests.md): one statement per topic the manager cares about, owning the feed schedule
-- that scans for it, plus explicit taste rules per feed project. Projections of Interest*, ScheduleLinked and
-- TasteSeedSet events.
CREATE TABLE interests (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES users(id),
  name                text NOT NULL,
  description         text NOT NULL DEFAULT '',
  feed_project_id     uuid REFERENCES projects(id),
  research_project_id uuid REFERENCES projects(id),
  sub_category        text,
  preferred_sites     text[] NOT NULL DEFAULT '{}',
  scan                jsonb,            -- {cron, timezone, windowHours, maxItems, manual}; NULL when there is no feed project
  status              text NOT NULL CHECK (status IN ('active','paused')),
  schedule_id         uuid,             -- the feed schedule it owns (no FK: created in the same append)
  adopted_from        uuid,             -- the schedule it was adopted from, if any
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  CHECK (feed_project_id IS NOT NULL OR research_project_id IS NOT NULL)
);
CREATE UNIQUE INDEX interests_name ON interests (org_id, lower(name));
CREATE INDEX interests_feed_project ON interests (feed_project_id) WHERE feed_project_id IS NOT NULL;
CREATE INDEX interests_research_project ON interests (research_project_id) WHERE research_project_id IS NOT NULL;

ALTER TABLE schedules ADD COLUMN interest_id uuid;
CREATE UNIQUE INDEX schedules_interest ON schedules (interest_id) WHERE interest_id IS NOT NULL;

ALTER TABLE cards ADD COLUMN interest_id uuid;
CREATE INDEX cards_interest ON cards (interest_id) WHERE interest_id IS NOT NULL;

CREATE TABLE taste_seeds (
  project_id  uuid PRIMARY KEY REFERENCES projects(id),
  version     integer NOT NULL,          -- bumps on every TasteSeedSet; carried to the vault section to drop stale writes
  rules       jsonb NOT NULL DEFAULT '[]', -- [{text, interestId | null}]
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL
);
```

- Add `interests` and `taste_seeds` to `PROJECTION_TABLES` (`apps/server/src/projections/index.ts`). `schedules.interest_id` and `cards.interest_id` are projection columns of existing projection tables, so a rebuild reproduces them.
- `apps/server/test/migrate.test.ts`: add the version if it lists them.

---

## 3. Events

New file `packages/shared/src/events/interest.ts` (registered in `events/index.ts`), stream `streamId.interest(id)` = `interest-<id>` (add to `packages/shared/src/ids.ts`), audience `project` with `projectScope(orgId, feedProjectId ?? researchProjectId)`.

| Event | Payload | Projection effect |
| --- | --- | --- |
| `InterestCreated` | `InterestBody` = `{interestId, orgId, name, description, feedProjectId: Id\|null, researchProjectId: Id\|null, subCategory: string\|null, preferredSites: string[], scan: ScanSpec\|null, status, scheduleId: Id\|null, adoptedFrom?: Id}` | insert `interests` |
| `InterestUpdated` | `InterestBody` (full snapshot, like `ScheduleUpdated`) | update `interests` |
| `InterestDeleted` | `{interestId, keepSchedule: boolean}` | delete row (cards keep `interest_id`; stats for a deleted interest are simply not shown) |

`ScanSpec = {cron: string (5 fields), timezone: IANA, windowHours: int 1..720, maxItems: int 1..100 (default 10), manual: boolean}`.

Changes to existing events:

| Event | Change | Projection effect |
| --- | --- | --- |
| `ScheduleCreated` (`events/schedule.ts`) | optional `interestId` | `schedules.interest_id` |
| `ScheduleLinked` (new, `events/schedule.ts`) | `{scheduleId, interestId: Id \| null}` | set `schedules.interest_id`; when linking, `UPDATE cards SET interest_id=$2 WHERE schedule_id=$1 AND interest_id IS NULL` (backfill; deterministic on replay because those cards were created earlier in the log) |
| `CardCreated` (`events/card.ts`) | optional `interestId` | `cards.interest_id` |
| `TasteSeedSet` (new, `events/feed.ts`, stream `project-<id>`) | `{projectId, version, rules: [{text (1..500), interestId: Id \| null}] (max 100)}` | upsert `taste_seeds`; the taste hook mirrors it to the vault (section 6) |

`ScheduleUpdated`'s upsert does not touch `interest_id` (it is not in its column list), so old and new events replay identically.

---

## 4. Commands and authorization

New file `apps/server/src/commands/interests.ts`. All writes run in `withAppendTx`; the interest row and its schedule row are locked `FOR UPDATE`.

### 4.1 Authorization (adds rows to §17.2)

| Action | Allowed for |
| --- | --- |
| List / view interests and their stats | active members of the feed project or the research project |
| Create, edit, pause/resume, delete, adopt | owner of the feed project (if any) **and** active member of the research project (if any). Research-only interest: owner of the research project. Both projects must belong to the same org; archived projects refused (409 `project_archived`) |
| Change the linked projects | as above, for both the old and the new projects |
| Run now | any active member of the feed project (unchanged `runFeedNow` rule) |
| Research this (`POST /api/cards {interestId}`) | any active member of the research project (unchanged card-create rule) |
| Set taste rules (project or per interest) | owner of the feed project |
| Edit or delete a linked schedule directly | nobody (409 `schedule_managed_by_interest`, `details.interestId`) |

### 4.2 Functions

- `createInterest(ctx, user, req)`
  1. If `req.newFeedProject`: validate like `createProject` (key free, `feed` workflow), append `ProjectCreated{workflowKey:'feed', domain, vaultFolder:null}` first (its projector runs in the transaction, so the project row exists for the next steps).
  2. Load and authorize the projects (4.1). `feed` project must have `fieldSet === 'feed'` (reuse `checkTemplate`); research project must have `fieldSet === 'research'` (400 `not_a_research_project`).
  3. `assertCronAndZone(scan.cron, scan.timezone)`; name unique per org (409 `interest_name_taken`).
  4. If `subCategory` is new for the research (else feed) project and the user owns it: append `ProjectUpdated{subCategories:[...old, new]}`. If not the owner, keep it on the interest only.
  5. One append: `InterestCreated{scheduleId}` + (feed project) `ScheduleCreated{interestId, name, kind:'feed', cron, timezone, cardTemplate: interestCardTemplate(i), enabled, nextFireAt}`.
- `updateInterest(ctx, user, id, patch)`: compute the next `InterestBody`, then `syncSchedule(tx, before, after)` returns the schedule events (4.3); append `InterestUpdated` + those events.
- `deleteInterest(ctx, user, id, {keepSchedule})`: `InterestDeleted` + (`ScheduleDeleted` | `ScheduleLinked{interestId:null}`).
- `adoptSchedules(ctx, user, scheduleIds[])`: for each schedule (kind `feed`, `interest_id IS NULL`, project owned by the user): `InterestCreated{adoptedFrom, scheduleId, name: unique(topic ?? schedule.name), description, preferredSites, subCategory:null, scan:{cron, timezone, windowHours: fields.windowHours ?? 24, maxItems: feedMaxItems(fields), manual:false}, status: enabled ? 'active' : 'paused'}` + `ScheduleLinked`. The template is not rewritten at adoption; the first edit of the interest normalizes it. Name collisions get ` (2)`, ` (3)`. One append per schedule so one bad schedule does not block the rest; the response lists `{scheduleId, interestId | error}`.
- `setTasteSeed(ctx, user, projectId, rules)` and `setInterestTaste(ctx, user, interestId, texts[])`: lock `taste_seeds` row (or treat as version 0), merge (the per-interest call replaces only rules tagged with that interest, so two open drawers do not overwrite each other's rules), dedupe case-insensitively, append `TasteSeedSet{version: old + 1}`.
- `commands/schedules.ts`:
  - `lockOwned` refuses linked schedules for `patchSchedule` and `deleteSchedule` (409).
  - `scheduledCard(...)` passes `interestId: s.interest_id` into `CardCreated`, and `runFeedNow` does the same when the schedule is linked.
  - Extract `scheduleUpdateEvent(s, next, now)` from `patchSchedule` (next-fire rules) so `syncSchedule` reuses it.
- `commands/cards.ts createCardIn`: optional `interestId` — the interest must be visible and its `research_project_id` (or `feed_project_id`) must equal `req.projectId` (400 `interest_project_mismatch`); written to `CardCreated.interestId`.

### 4.3 Sync rules interest → schedule (`syncSchedule`, pure decision in `packages/shared/src/interests/index.ts scheduleSyncPlan(before, after)`, applied by the server)

| Change | Schedule events |
| --- | --- |
| Feed project added | `ScheduleCreated{interestId}` |
| Feed project removed | `ScheduleDeleted` (interest keeps its research project) |
| Feed project changed | `ScheduleDeleted(old)` + `ScheduleCreated(new project)`; past cards keep `interest_id`, so stats stay whole |
| name, description, preferred sites, sub-category, window, max items | `ScheduleUpdated{cardTemplate, name}` (pending fire kept) |
| cron or timezone | `ScheduleUpdated` with `nextFireAt` recomputed |
| status or `scan.manual` | `ScheduleUpdated{enabled}`; re-enabling recomputes `nextFireAt` |
| Nothing schedule-relevant changed | none |
| Interest deleted | `ScheduleDeleted`, or `ScheduleLinked{null}` with `keepSchedule` |

Invariants (asserted in tests): a linked schedule's `card_template` always equals `interestCardTemplate(interest)` after the interest's first edit; `enabled` always equals the derived value; at most one schedule per interest (unique index). Archived projects: schedules already stop firing; the interest shows "project archived" and cannot be resumed until the project is active.

---

## 5. "Research this"

- Shared helper `researchCardDefaults(interest)`: `title: "Research: <name>"`, `question: "What should I know now about <name>?"` (edited in the dialog), `scope: description`, `subCategory`, `preferredSites`, `depth: 'standard'`.
- Dialog submits `POST /api/cards {projectId: researchProjectId, title, cardType: 'research', fields, interestId, specify: true}`; "Save as draft" sends `specify: false`.
- When the interest has no research project, the button opens the project select first (research projects the user is a member of) with "Remember for this interest" (owner only → `PATCH /api/interests/:id {researchProjectId}`).
- Published notes (`research_publications` joined on `cards.interest_id`) appear on the interest.

---

## 6. Taste seeding flow (server → runner → vault)

```
manager edits rules (drawer or Taste panel)
  → PUT /api/interests/:id/taste | PUT /api/projects/:id/taste-seed
  → TasteSeedSet{projectId, version, rules}            (event; taste_seeds projection)
  → taste hook (commands/taste.ts, store.subscribe)
      → enqueueVaultWrite(projectVault, {path: <folder>/taste.md, mode:'section',
           section:{id:'seed', version}, content: renderTasteSeedSection(rules, interestNames), header: TASTE_HEADER})
  → runner vault.write (apps/runner/src/vaults/write.ts) → applyTasteSection → commit → push
feed shift brief (runner-gateway/brief.ts)
  → brief.feed.tasteSeed = rules for this project, untagged + tagged with card.interest_id
  → runner vaults/context.ts reads taste.md, strips the managed section (stripManagedSection) → brief.feed.taste
  → shift-prompt: "### Explicit taste rules (set by the manager; follow these first)" then "### Taste (taste.md)"
```

Rendering in `taste.md` (shared `renderTasteSeedSection`):

```
# Taste

Rules and examples from the manager's ratings, one per line. ...

<!-- aom:section seed v=4 begin. Managed on the site (Interests page); edits here are overwritten. -->
## Explicit rules

- Rule: Prefer primary sources over aggregators.

### Rust async (interest)

- Rule: Skip beginner tutorials.
<!-- aom:section seed end -->

- Prefer articles like "..." from ... (rated useful). Example: https://...
```

- `vault.write` gains `mode: 'section'` with `section: {id: /^[a-z-]+$/, version: int}` (`packages/shared/src/vaults/index.ts`). The pure function `applyManagedSection(current | null, header, id, version, content)` in shared:
  - file missing → `header + block`;
  - block present with `v >= version` → unchanged (stale or duplicate write; idempotent);
  - block present, older → replace between the markers;
  - no block → insert right after the header paragraph (before the first `- ` line), else append.
- No vault, or no workstation holding a clone: nothing is written (as for ratings today). Curators still get the rules from the brief, so behaviour is correct; the drawer shows "Not yet written to taste.md" when `taste_seeds.version` is ahead of the vault mirror. The mirror catches up on the next `TasteSeedSet`; `POST /api/projects/:id/taste-seed/resync` re-sends the current version (owner).
- Site view: `tasteFor` (`queries/digests.ts`) returns the explicit rules first (`source: 'seed'`), then rating lines and approved proposals as today.
- Curator instructions (`packages/shared/src/roles/builtin.ts`, curator role version +1): "Explicit taste rules come first and win when a rating line disagrees; rating lines are examples." Approved curator rule proposals stay append-only lines (unchanged), and the drawer offers "Make explicit" on them later (out of scope, open question 9).
- Version skew: an older runner fails `section` writes (zod enum). Cosmetic only (the brief carries the rules); the hook skips the write when the target workstation's reported `runnerVersion` is below the version that ships this, and the drawer says "update the runner to mirror rules into taste.md".

---

## 7. REST API (`packages/shared/src/api/interests.ts`, `apps/server/src/routes/interests.ts`)

| Method & path | Purpose | Who |
| --- | --- | --- |
| `GET /api/interests?projectId=&status=` | list with `stats` (below) | member of a linked project |
| `GET /api/interests/:id` | detail: interest, stats, last 5 scan cards (`ref, status, firedAt, items, nothingQualified`), last 5 publications, its taste rules, schedule `{id, nextFireAt, failCount, lastError}` | member |
| `POST /api/interests` | `{name, description?, feedProjectId? \| newFeedProject?:{key, name, domain}, researchProjectId?, subCategory?, preferredSites?, scan?, status?}` → `{id}` | 4.1 |
| `PATCH /api/interests/:id` | partial of the above (no `newFeedProject`) | 4.1 |
| `DELETE /api/interests/:id?keepSchedule=` | delete | 4.1 |
| `POST /api/interests/:id/run` | run the feed now (`runFeedNow({scheduleId})`) → `{cardId, ref}`; 409 `no_feed_project` | feed member |
| `GET /api/interests/adoptable` | unlinked feed schedules of projects the user owns | owner |
| `POST /api/interests/adopt` `{scheduleIds}` | → `{results:[{scheduleId, interestId?, error?}]}` | owner |
| `PUT /api/interests/:id/taste` `{rules: string[]}` | replace this interest's explicit rules | feed owner |
| `GET /api/projects/:id/taste-seed` · `PUT` `{rules:[{text, interestId?}]}` · `POST .../resync` | project-wide explicit rules | member / owner |
| `POST /api/cards` | gains `interestId?` | unchanged |
| `GET /api/digest-items?projectId=&interestId=` | filter for the interest's digest link | unchanged |
| `GET /api/research/publications?projectId=&interestId=` | filter | unchanged |
| `GET /api/schedules` | `ScheduleDto` gains `interestId`, `interestName` | unchanged |

`InterestStats`: `{lastScanAt, lastScanCard:{id, ref, status} | null, nextScanAt, scans30d, items: {total, last30d, lastScan}, ratings: {useful, irrelevant, boring, unrated}, research: {open, published}, failing: boolean}`. One SQL per list (CTEs grouped by `cards.interest_id`), no N+1.

---

## 8. Web UI (`apps/web`)

### 8.1 Navigation

The planned side-menu redesign gets a nav config `apps/web/src/components/nav.ts` (`NAV_GROUPS: [{label, items:[{to, label, testId}]}]`). This feature adds the **Knowledge** group: Interests (`/interests`), Ledger (`/ledger`), Vaults (`/settings/vaults`). Until the side menu lands, `Layout.tsx` renders an "Interests" link next to "Schedules". Schedules stays (it also holds regression and card schedules).

### 8.2 List (`pages/Interests.tsx`, route `/interests`, deep link `/interests?open=<id>`)

Desktop (≥ sm):

```
+----------------------------------------------------------------------------------+
| Interests                                         [Adopt 3 schedules] [+ New]    |
| What you care about across feed and research projects.                           |
| Filter: [All projects v] [Active v]  Search [__________]                          |
+----------------------------------------------------------------------------------+
| ! 3 feed schedules are not interests yet.  [Review and adopt]            [x]     |
+----------------------------------------------------------------------------------+
| Rust async                            NEWS (feed) · RES (research) · rust/async  |
| Daily 07:00 Africa/Johannesburg · 24 h · 10 items            [Active]            |
| Last scan 07:02 today (NEWS-41, 6 items) · next tomorrow 07:00                   |
| Ratings  useful 12 · irrelevant 3 · boring 5 · unrated 2   Notes 2 · open 1      |
| [Run now] [Research this] [Digests] [Notes]                       [Edit]  [...]  |
+----------------------------------------------------------------------------------+
| Reloading powders (research only)            RES · shooting/reloading [Active]   |
| Notes 4 · open 0                                [Research this] [Notes] [Edit]   |
+----------------------------------------------------------------------------------+
| Project taste rules                                                               |
| NEWS: 3 explicit rules · written to taste.md v4            [Edit taste rules]    |
+----------------------------------------------------------------------------------+
```

Mobile (< sm): one card per interest, buttons wrap into a row of icon+label buttons (44 px targets), the "..." menu holds Pause/Resume, Delete, Open schedule.

```
+--------------------------------+
| Interests            [+ New]   |
| [All projects v] [Active v]    |
+--------------------------------+
| Rust async          [Active]   |
| NEWS · RES · rust/async        |
| Daily 07:00 · last 07:02 (6)   |
| U12 I3 B5 ?2 · notes 2         |
| [Run] [Research] [Edit] [...]  |
+--------------------------------+
```

Failing schedule: red badge "Cannot run (3 tries)" with `lastError`, as on Schedules.

### 8.3 Edit drawer (`components/interests/InterestDrawer.tsx`, Radix Dialog; right panel 480 px on ≥ sm, full-screen sheet on mobile, sticky footer)

```
+------------------------------------------------+
| Edit interest: Rust async                  [x] |
|------------------------------------------------|
| Name        [Rust async_____________________]  |
| Description (markdown; angle, include/exclude, |
| level - agents follow this first)              |
| [ Deep dives on tokio internals, async       ] |
| [ traits, executors. Exclude beginner ...    ] |
|                                                |
| Feed project   [NEWS v] (+ New feed project)   |
|   +-- New: Key [AIF] Name [AI feeds] [personal v]
| Research project [RES v] [none]                |
| Sub-category   [rust/async v] (suggestions)    |
| Preferred sites [lobste.rs, without.boats ...] |
|                                                |
| Scan                                           |
|  When  [Daily at 07:00 v] [custom cron____]    |
|  Time zone [Africa/Johannesburg v]             |
|  Window (hours) [24]   Max items [10]          |
|  [ ] Manual only (Run now)                     |
|  Next run: tomorrow 07:00                      |
|                                                |
| Taste rules for this interest (NEWS taste.md)  |
|  - Skip beginner tutorials           [edit][x] |
|  [+ Add rule________________________] [Add]    |
|  Mirrored to taste.md v4 / not yet written     |
|                                                |
| Status (o) Active ( ) Paused                   |
|------------------------------------------------|
| [Delete...]                  [Cancel] [Save]   |
+------------------------------------------------+
```

- Feed and research project selects list only projects the user may use (feed: owned `feed` workflow projects; research: member `research` projects). "+ New feed project" expands inline fields; key auto-suggested from the name (`suggestProjectKey`).
- Fields that a guest member cannot change render read-only with "Only the project owner can edit this interest".
- Delete opens a confirm with "Keep the schedule as a plain schedule" checkbox.
- Taste rules in the drawer save with Save (they are a separate `PUT /api/interests/:id/taste` call after the interest PATCH succeeds; errors show inline).

### 8.4 Research-this dialog (`components/interests/ResearchThisDialog.tsx`)

```
+--------------------------------------------+
| Research this: Rust async             [x]  |
|--------------------------------------------|
| Project  [RES v]                           |
| Title    [Research: Rust async__________]  |
| Question [What should I know now about  ]  |
|          [Rust async?                   ]  |
| Scope    [Deep dives on tokio internals,]  |
|          [... (from the description)    ]  |
| Depth    ( ) Quick (o) Standard ( ) Deep   |
| Sub-category [rust/async]                  |
| Preferred sites [lobste.rs, ...]           |
|--------------------------------------------|
| [Save as draft]          [Create and queue]|
+--------------------------------------------+
```

On success: toast with the card ref linking to `/cards/<id>`.

### 8.5 Adopt dialog (`components/interests/AdoptSchedulesDialog.tsx`)

A checklist of `GET /api/interests/adoptable` (name, project, cadence, topic), all checked, "Adopt selected"; results per row (created / error).

### 8.6 Other pages

- `pages/Schedules.tsx`: linked rows show "Managed by interest <name>" with a link to `/interests?open=<id>`; Edit/Delete/Pause hidden for them; Run now kept. `NewSchedule` for feed projects gets a hint "Feeds are easier to manage as Interests" with a link.
- `pages/FeedProject.tsx`: `?interest=<id>` filters the running list (digest items query `interestId`), with a chip to clear it.
- `components/PublicationPanel.tsx` unchanged; the interest's Notes link goes to `/interests?open=<id>#notes` (detail lists publications with links to their cards).
- Queries: `apps/web/src/api/queries/interests.ts` (`useInterests`, `useInterest`, `useCreateInterest`, `usePatchInterest`, `useDeleteInterest`, `useRunInterest`, `useAdoptable`, `useAdopt`, `useInterestTaste`, `useTasteSeed`).
- Live updates (`ws/invalidate.ts`): `Interest*` → `['interests']`, `['interest', id]`, `['schedules']`; `ScheduleLinked` → `['schedules']`, `['interests']`; `TasteSeedSet` → `['taste', projectId]`, `['interests']`; `DigestPosted`, `ItemRated`, `ResearchPublished`, `ScheduleFired`, `FeedRunRequested`, `CardCreated` → also `['interests']` (stats).
- MSW: `apps/web/src/mocks/handlers-extra.ts` + `mocks/db.ts` for the new routes.

---

## 9. Mock runtime and e2e (token-free)

- No new shift kinds. Feed cards of an interest are ordinary feed cards with `topic/description/...` and `subCategory`.
- `apps/runner/src/adapters/mock-agent.ts` curator: emits `mock taste seed: N rule(s)` and one `mock taste seed rule: <text>` per rule from `brief.feed.tasteSeed`; a seed rule matching `/skip "([^"]+)"/i` drops candidates with that exact title (mirrors the existing `Skip ... like "<title>"` handling). It also asserts the stripped `taste` contains no `aom:section` marker (progress line `mock taste: managed section stripped`).
- Vault fixture (`e2e/support/vault.ts`) is reused to check the managed section lands in `projects/<folder>/taste.md` above rating lines, and is replaced (not duplicated) on the next edit.
- Scheduling in e2e uses "Run now" from the interest, so no test waits on cron. The cron path (`fireDueSchedules` setting `cards.interest_id`) is covered by server tests with the test clock.

---

## 10. Test plan

**Shared (vitest)** `packages/shared/test/interests.test.ts`:
- `interestCardTemplate` (defaults: window from cron, maxItems 10, omits empty description/sites).
- `scheduleSyncPlan`: every row of 4.3.
- `defaultWindowHours` per preset; `researchCardDefaults`.
- `renderTasteSeedSection` (general + per-interest groups, empty rules) and `applyManagedSection` (missing file, insert after header, replace, stale version no-op, identical no-op, markers with CRLF).
- `stripManagedSection` round trip.
- Event schema round trips (`InterestCreated/Updated/Deleted`, `ScheduleLinked`, `TasteSeedSet`, `CardCreated.interestId`); `VaultWriteCommandSchema` with `section`.
- `feedContext` prompt snapshot with explicit rules and with none.

**Server (vitest + `aom_test`)**, new files in `apps/server/test/`:
- `interests.test.ts`: create with feed / research / both / neither (400); `newFeedProject` creates project + interest + schedule in one transaction (and nothing when the key is taken); name uniqueness; non-owner of feed project 403; guest member can list but not edit; research project of another org 404; sub-category added to the project for the owner only.
- `interests-sync.test.ts`: each 4.3 row produces the expected schedule row (`card_template`, `enabled`, `next_fire_at`); pause keeps the template; moving feed project deletes and recreates; linked schedule `PATCH`/`DELETE` → 409, run now allowed; `fireDueSchedules` sets `cards.interest_id`; delete with and without `keepSchedule`.
- `interests-adopt.test.ts`: adopt maps fields (legacy `maxPerKind` → `maxItems`), disabled → paused, name collisions suffixed, other users' schedules refused, already linked refused, earlier cards backfilled.
- `interests-stats.test.ts`: digests, ratings, publications and failing schedule counted per interest; adopted history included.
- `taste-seed.test.ts`: version bump and merge per interest; the hook queues one `vault.write {mode:'section'}` with the rendered content; no vault → nothing queued; old runner version → skipped; brief for a feed card carries untagged + own-interest rules only; `tasteFor` lists seed rules first.
- `cards.test.ts` (extend): `interestId` validated against the project.
- `interests-rebuild.test.ts`: replay equals live state for `interests`, `taste_seeds`, `schedules.interest_id`, `cards.interest_id`.
- Extend `isolation.test.ts` (another user sees no interests, adoptables or taste seeds) and `migrate.test.ts`.

**Runner (vitest)**:
- `apps/runner/test/vault-write.test.ts` (extend): `section` mode create / insert / replace / stale / identical-no-commit.
- `apps/runner/test/vault-context.test.ts` (extend): managed section stripped from `taste`.

**Web (vitest + testing-library)** `apps/web/test/interests.test.tsx`: list renders stats and failing badge; drawer validation (cron, at least one project), inline new project fields, read-only for guests; research dialog prefill and submit payload (`interestId`, `specify`); adopt dialog results; Schedules page locks linked rows; mobile layout (drawer is full screen under `sm` via class assertions).

**E2E (Playwright, mock runtime)** `e2e/tests/interests.spec.ts`:
1. Setup: paired workstation, personal vault, scout + curator + researcher + checker hired; one plain feed schedule created the old way.
2. Adopt: banner shows 1 schedule; adopt; the interest appears, Schedules shows "Managed by interest", Edit is gone.
3. New interest with inline new feed project and an existing research project; Schedules shows the new linked schedule with the template; editing the interest description updates the schedule's description.
4. Taste: add a project rule and an interest rule `skip "Boring headline"`; `taste.md` in the origin has the managed section above any rating lines; edit the rule; the section is replaced, not duplicated.
5. Run now with `mockFeed` items including "Boring headline": the digest omits it; the shift log shows `mock taste seed: 2 rule(s)`; rate items; the interest shows ratings `useful 1 · boring 1`; Digests link filters the feed page.
6. Research this: the dialog is prefilled; create; the mock researcher/checker publish; the interest shows `Notes 1` linking to the card.
7. Pause: the schedule is disabled; resume re-enables with a fresh next run. Mobile viewport (390x844) screenshot of list and drawer for the guide.

---

## 11. Risks

- **Shared-project visibility**: an interest's events carry one project scope (feed project, else research). A member of only the research project gets no live WS invalidation for it; the REST list is still correct. Acceptable; noted in `ws/invalidate.ts` comment.
- **Concurrent edits** of the same interest: last write wins on full snapshots; mitigated by row locks and the drawer refetching on open. Optional `ifUpdatedAt` precondition (409 `stale_interest`) if this bites.
- **Vault mirror lag**: `taste.md` may lag the site; correctness does not depend on it (brief carries rules). Manager edits inside the managed section in Obsidian are overwritten; the marker says so.
- **Runner version skew** for `section` writes: guarded by `runnerVersion`; cosmetic only.
- **Migration number** collisions with the phases design (`1300_`, `1400_`): this feature takes `1500_`; rebase if the numbering changes.
- **Curator role version bump** (`builtin.ts`) may conflict with concurrent role edits; rebase onto them.

---

## 12. Open questions, each with a recommended default

1. **Who may manage interests in a shared project?** Default: the feed project's owner (same as schedules). Members view, run now, research this and rate.
2. **May a linked schedule be edited on the Schedules page?** Default: no, locked (409) with a link to the interest; run now allowed; deleting the interest with "keep schedule" unlinks it.
3. **Taste rules per project or per interest?** Default: stored per feed project, each rule optionally tagged with an interest; tagged rules reach only that interest's cards. Per-interest include/exclude that is really scope belongs in the description.
4. **Who owns the managed section of `taste.md`?** Default: the site. Obsidian edits there are overwritten; rating lines below remain freely editable.
5. **Seed taste for research projects?** Default: no; `taste.md` is a feed concept. Research intent comes from the interest description (scope).
6. **Research-only interests (no feed project)?** Default: allowed.
7. **Inline new feed project?** Default: yes, key + name + domain only, `feed` workflow, default vault folder; full settings stay on the project page.
8. **Adopt automatically?** Default: no, banner + explicit adopt (dismissible per session).
9. **Turn an approved curator rule proposal or a rating into an explicit rule from the site?** Default: later ("Make explicit" on taste lines); out of scope here.
10. **Window default.** Default: derived from cadence (hourly 1 h, daily 24 h, weekly 168 h), overridable.
11. **Feed cards get `subCategory`?** Default: yes, optional field on the feed field set, shown in the prompt and card; no change to where files go.
12. **Stats window.** Default: all-time plus last 30 days for items and scans; ratings all-time.
13. **"Research this" auto-queues?** Default: yes (`specify: true`), with "Save as draft".
14. **One research project per interest?** Default: yes; the dialog may pick another research project for a one-off card without changing the interest.

---

## 13. Implementation plan (ordered, small steps)

Each step ends green (`pnpm typecheck && pnpm lint && pnpm test`). Paths are relative to the repo root.

1. **Shared: interest module.**
   - Create `packages/shared/src/interests/index.ts`: `ScanSpecSchema`, `InterestBodySchema`, `interestCardTemplate`, `defaultWindowHours`, `scheduleSyncPlan`, `researchCardDefaults`, `suggestProjectKey`.
   - Export from `packages/shared/src/index.ts`; add `streamId.interest` in `packages/shared/src/ids.ts`.
   - Test: `packages/shared/test/interests.test.ts` (template, window, sync plan, research defaults).
2. **Shared: taste section helpers.**
   - `packages/shared/src/feed/index.ts`: `TasteSeedRuleSchema`, `renderTasteSeedSection`, `applyManagedSection`, `stripManagedSection`, marker constants.
   - `packages/shared/src/vaults/index.ts`: `VaultWriteCommandSchema.mode` adds `'section'` + optional `section: {id, version}` (refine: required when mode is `section`).
   - Tests in `packages/shared/test/interests.test.ts` (or `feed.test.ts` if it exists).
3. **Shared: events.**
   - Create `packages/shared/src/events/interest.ts`; register in `events/index.ts`.
   - `events/schedule.ts`: `ScheduleCreated.interestId?` (split `ScheduleBody` so `ScheduleUpdated` stays unchanged), new `ScheduleLinked`.
   - `events/feed.ts`: `TasteSeedSet`. `events/card.ts`: `CardCreated.interestId?`.
   - `cards/fields.ts`: optional `subCategory` in the feed field set (`FeedFieldsBase`, `FEED_FIELDS`).
4. **Shared: API and protocol.**
   - Create `packages/shared/src/api/interests.ts` (DTOs, stats, requests, adopt, taste); register in `api/index.ts`.
   - `api/schedules.ts`: `ScheduleDto.interestId/interestName`. `api/cards.ts`: `CreateCardRequest.interestId?`. `api/digest.ts`, `api/research.ts`: `interestId` query. Taste response gains `source: 'seed'` lines.
   - `protocol/runner.ts`: `ShiftBrief.feed.tasteSeed: string[]` (default `[]`).
   - `prompt/shift-prompt.ts`: "Explicit taste rules" block; `subCategory` line. Snapshot test.
5. **Migration.** Create `apps/server/migrations/1500_interests.sql` (section 2); update `apps/server/test/migrate.test.ts` if needed.
6. **Projections.**
   - Create `apps/server/src/projections/interests.ts` (`InterestCreated/Updated/Deleted`, `TasteSeedSet`).
   - `projections/schedules.ts`: `interest_id` on `ScheduleCreated`; `ScheduleLinked` with card backfill.
   - `projections/cards.ts`: `CardCreated.interestId`.
   - Register in `projections/index.ts`; add `interests`, `taste_seeds` to `PROJECTION_TABLES`.
   - Test: `apps/server/test/interests-rebuild.test.ts`.
7. **Schedule changes.**
   - `apps/server/src/commands/schedules.ts`: lock linked schedules (409), pass `interestId` in `scheduledCard`/`runFeedNow`, extract `scheduleUpdateEvent`, `listSchedules` joins the interest name.
   - Extend `apps/server/test/schedules.test.ts` (or the existing scheduler test file).
8. **Interest commands, queries, routes.**
   - Create `apps/server/src/commands/interests.ts` (create incl. `newFeedProject`, update + `syncSchedule`, delete, adopt, run).
   - Create `apps/server/src/queries/interests.ts` (list with stats CTE, detail, adoptable).
   - Create `apps/server/src/routes/interests.ts`; register in `apps/server/src/app.ts`.
   - Tests: `interests.test.ts`, `interests-sync.test.ts`, `interests-adopt.test.ts`, `interests-stats.test.ts`.
9. **Research this (server).**
   - `apps/server/src/commands/cards.ts createCardIn`: validate and pass `interestId`.
   - `queries/digests.ts`, `queries/research.ts` + their routes: `interestId` filter.
   - Extend `apps/server/test/cards.test.ts`.
10. **Taste seed (server).**
    - `commands/interests.ts` (or new `commands/taste-seed.ts`): `setTasteSeed`, `setInterestTaste`, `resyncTasteSeed`; routes in `routes/interests.ts` and `routes/digests.ts` (`/api/projects/:id/taste-seed`).
    - `commands/taste.ts registerTasteHook`: `TasteSeedSet` → `section` write (skip on old `runnerVersion` via `chooseVaultWriteTarget` result).
    - `runner-gateway/brief.ts`: `feed.tasteSeed` for the card's project and interest.
    - `queries/digests.ts tasteFor`: seed lines first.
    - Test: `apps/server/test/taste-seed.test.ts`.
11. **Runner.**
    - `apps/runner/src/vaults/write.ts`: `section` mode via `applyManagedSection`.
    - `apps/runner/src/vaults/context.ts`: `stripManagedSection` before setting `taste`.
    - `apps/runner/src/adapters/mock-agent.ts`: seed rule progress lines and `skip "<title>"`.
    - Tests: extend the runner vault write and context tests.
12. **Curator instructions.** `packages/shared/src/roles/builtin.ts`: curator role version +1 with the precedence rule; update any role snapshot test.
13. **Web: data layer.** Create `apps/web/src/api/queries/interests.ts`; `ws/invalidate.ts` mappings; MSW handlers in `apps/web/src/mocks/handlers-extra.ts` and `mocks/db.ts`.
14. **Web: nav and list.** Create `apps/web/src/components/nav.ts` (Knowledge group); `components/Layout.tsx` link; create `pages/Interests.tsx`; route `/interests` in `router.tsx`.
15. **Web: drawer, dialogs.** Create `components/interests/InterestDrawer.tsx`, `ResearchThisDialog.tsx`, `AdoptSchedulesDialog.tsx`, `TasteRulesEditor.tsx` (shared by drawer and project taste panel); helpers in `apps/web/src/lib/interests.ts` (reuse `lib/feeds.ts` `describeCron`, `defaultTimezone`, `parseSites`).
16. **Web: existing pages.** `pages/Schedules.tsx` locked rows + hint; `pages/FeedProject.tsx` `?interest=` filter. Test: `apps/web/test/interests.test.tsx` and extend the Schedules test.
17. **E2E.** `e2e/tests/interests.spec.ts` (section 10); extend `e2e/support` only if a helper is missing.
18. **Docs.** `docs/SPEC.md` ("Research and feeds": interests and explicit taste rules), `docs/ARCHITECTURE.md` (§4.2 tables, §5.2 events, §16.4 `section` writes, §17.2 rows, §19 routes, §21 route), `docs/USER-GUIDE.md` (Interests page), and mark this design as built.

## Provisional decisions (orchestrator, 2026-10-05, owner away; owner may override)

The recommended defaults are accepted, with one exception that follows the owner's phases decision A1 ("any member, everything"):

- **Q1:** any member of the feed project may create, edit, pause and delete interests and their taste rules, not only the owner.
- Q2–Q14 use the recommended defaults as written above.

## Implementation status (built Oct 6, 2026)

Built in the order of section 13, with the provisional decisions above (any member of the linked projects manages; Q2-Q14 as recommended). Migration **`1306_interests.sql`** instead of `1500_`.

| Step | Status | Notes |
| --- | --- | --- |
| 1-4 Shared module, taste helpers, events, API and protocol | built | `interests/index.ts`, `feed/index.ts` (`renderTasteSeedSection`, `applyManagedSection`, `stripManagedSection`), `events/interest.ts`, `api/interests.ts`; `ShiftBrief.feed.tasteSeed`; feed `subCategory` field |
| 5-6 Migration and projections | built | `interests`, `taste_seeds`, `schedules.interest_id`, `cards.interest_id`; `deleteProjectRows` also cleans interests and seeds |
| 7 Schedule changes | built | linked schedules answer 409 `schedule_managed_by_interest`; `scheduleUpdateEvent` extracted; cards of a linked schedule carry `interest_id` |
| 8 Commands, queries, routes | built | create (incl. `newFeedProject`), update with `syncSchedule`, delete (`keepSchedule`), adopt, run; stats in one query round |
| 9 Research this (server) | built | `interestId` on `POST /api/cards`; `interestId` filters on digest items and publications |
| 10 Taste seed (server) | built | `setTasteSeed`, `setInterestTaste`, resync; the hook writes a `section` vault write; brief carries the rules; `tasteFor` lists them first. Renaming or deleting an interest re-renders the section (extra `TasteSeedSet`) |
| 11 Runner | built | `section` mode in `vaults/write.ts`, managed block stripped in `vaults/context.ts`, mock curator reads `tasteSeed` and `skip "<title>"` |
| 12 Curator instructions | built | curator role version 4 |
| 13-16 Web | built | Interests page, drawer, Research-this and Adopt dialogs, taste editors, Schedules lock and hint, `?interest=` filter on the feed page, live updates, `components/nav.ts` |
| 17 E2E | built | `e2e/tests/interests.spec.ts` |
| 18 Docs | built | USER-GUIDE (Interests), ARCHITECTURE, SPEC |

**Deferred or different from the plan**

- The "version skew" guard (skip the section write for a runner older than this feature, and say "update the runner" in the drawer) is not built: the runner version is a constant (`0.1.0`) that cannot tell old from new. An old runner rejects the write; only the `taste.md` mirror is late, the brief still carries the rules.
- The drawer shows whether the project has a vault ("Mirrored to taste.md (rules version N)" or "no vault: brief only"); it does not know whether the runner has already written that version, because a completed `vault.write` is not an event. The resync endpoint (`POST /api/projects/:id/taste-seed/resync`) now has a "Resync taste.md" button in the project taste rules dialog.
- `Notes` opens an inline panel of recent scans and published notes on the card instead of a separate `#notes` route; `/interests?open=<id>` opens the edit panel.
- The optional `ifUpdatedAt` precondition (409 `stale_interest`) is not built; concurrent edits are last-write-wins with the drawer refetching on open.
- "Make explicit" on rating lines and approved rule proposals (open question 9) stays out of scope.
- A research-only interest edited by a member who is in the research project only is allowed; a member of just one of two linked projects cannot edit (403) but can run (feed) or research (research).
