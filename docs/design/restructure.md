# Design: org-level interests, generic schedules, org agents and research-to-project

Oct 6, 2026 · status: design; **Parts A (org-level agents), B (generic schedules) and C (research stage and conversion) built, 7 Oct 2026** (see Implementation status at the end), Part D not built · companion to `docs/SPEC.md`, `docs/ARCHITECTURE.md` (referenced as §n), `docs/design/interests.md` (built, superseded in part by this) and `docs/design/phases.md`

This design implements the owner's "Model restructure" decisions in `docs/design/open-questions.md`:

1. Interests replace feed projects and feed schedules.
2. Schedules become generic cron jobs.
3. Agents belong to the organization, not to a project.
4. Research is a starting stage of a project, not a project type.

It also covers what these changes mean for phases, the reporter, hygiene, archive and delete, the Interests page, the nav, the e2e suite and the mock runtime.

Migration numbers: the last one is `1306_interests.sql`. This design uses `1310_` to `1314_`. A builder is editing `apps/` in parallel, so take the next free numbers at build time and keep the order given here.

---

## 0. Decision summary

| # | Decision | Chosen | Rejected alternatives (one line each) |
| --- | --- | --- | --- |
| D1 | Where interest runs live | Each interest is backed by one **hidden project** (`projects.kind = 'interest'`). Its feed and research cards, `digest_items`, `feed_seen`, `transcripts` and vault folder are that project's, so the card pipeline, dispatcher, claims, shifts, ratings and transcripts work unchanged. Users never see it as a project. | Cards with `project_id NULL`: every candidate, visibility, domain and vault query joins `projects`, so about 40 queries would change. One hidden "interests" project per org and domain: `feed_seen`, `transcripts`, taste and the vault folder would all need an `interest_id` key, which is a second model next to the project one. Feed runs as a non-card queue (like `ba_tasks`): the scout/curator pipeline, its handoffs, the transcript checks and the mock would all need rewriting. |
| D2 | Interest cadence | Owned by the interest (`interests.scan` + `next_scan_at`) and fired by a new `fireDueInterests` step in the existing scheduler tick. No `schedules` row. | Keep a locked, interest-owned schedule (today): this is the duplicated control the owner flagged; the 409 `schedule_managed_by_interest` dance goes away. |
| D3 | Run log | New projection `interest_runs`: one row per scan or research run, keyed to its card. It holds status, found, published, dropped and notes counts. Ratings and transcripts are joined at read time. | Deriving runs from `cards` at read time: "found" (candidate count) and the trigger are not on the card, and the list query would grow with each new column. |
| D4 | Taste | Taste is part of the interest: `interests.taste_rules` and `taste_version` (event `InterestTasteSet`), mirrored as the managed `seed` section of `<interest folder>/taste.md`. Ratings append to the same file, routed by the card's `interest_id`. | Keep `taste_seeds` per project with `interestId` tags: with one backing project per interest the tag is meaningless, and the owner asked for taste built into the interest. |
| D5 | Vault layout | New interests use `interests/<slug>/` in the org's work or personal vault (new `projects.vault_dir` overrides `projects/<vault_folder>`). Migrated feed projects **keep their existing folder**, so no files move. | Moving files at migration: the site cannot read the vault, and a new runner `vault.move` command for a one-off is risky with sync conflicts. Offered later as "Move folder" (open question Q6). |
| D6 | Migrating feed projects | A one-off **event-appending data migration** (`restructure-2026-10`) runs at boot under an advisory lock and is recorded in `data_migrations`. Each feed project becomes the backing project of its first interest. Further interests get new backing projects, with `feed_seen`, `transcripts` and members copied. Feed schedules not yet adopted become interests automatically. | SQL-only migration: it cannot append events, so a projection rebuild would lose the result (the reason interests.md refused auto-adopt). A manual "Adopt" banner: feed projects disappear from the UI, so nothing may stay orphaned. |
| D7 | Agent scope | `agents.project_id` is gone. An agent may work a card when the card is in the agent's org **and the user who owns the agent's workstation is an active member of the card's project**. Workstation and vault checks are unchanged. | Fully org-wide with no membership check: a guest manager's agent would pull the owner's private repos onto the guest's machine. Moving guest agents into the guest's own org: their roles come from the owner's catalogue, so they would break. |
| D8 | Choosing projects for an agent | The candidate order stays (scheduled, then work before personal, then rework, then tier, then priority, then FIFO). Two soft terms are added: the agent's **focus projects** (set on the HR card) before the tier, and the project's **preferred skills** overlap after the tier. Capacity stays per agent. | Hard per-project pinning: this re-introduces project scoping under another name. Per-project WIP limits: there is no stated need (Q11). |
| D9 | Project delete | It no longer retires agents. Agents keep `hired_for_project_id` as history only. | Retire when the agent has no other project: surprising, and the owner wants the agent kept. |
| D10 | Schedules | One generic model: **trigger** (cron + timezone, or manual only) and **action** (`create_card`, `regression_run`, `devops_request`, `ba_task`, `integration`). Actions are stored as jsonb `action`. Legacy `kind` + `card_template` rows are read as `create_card` / `regression_run`. | A table per action kind: the scheduler, backoff and failure notices would be duplicated. An event-trigger engine now: no requirement yet (Q9). |
| D11 | Research stage | A project created as **Research** has `workflow_key='research'`. **Conversion** is one event, `ProjectConverted`, that sets a new workflow (code or custom), appended with the repos it adds. Cards in flight keep their workflow version. Research cards are allowed in every project: the card's workflow is resolved by card type. | A `projects.stage` column next to `workflow_key`: two fields would say the same thing. Re-creating the project as code and moving cards: card refs, events and the vault folder would break. |
| D12 | Authorization | Interests and their taste: any active member of the backing project (which starts with the creator, plus the org owner). Conversion: the project owner. Schedules: any active project member for project actions; DevOps and integration actions only by the user who owns the target workstation; org-level actions only by the org owner. | Owner only for interests: this contradicts the owner's "any member" answer (Q11/12). |

---

## 1. Concepts after the change

- **Organization**: still `org_id = users.id`. An **org member** is the owner, or any user with an active `project_members` row in one of the org's projects. A helper (`orgMembership(userId, orgId)`) is added in `apps/server/src/authz/scope.ts` and mirrored in `packages/shared/src/authz`.
- **Project**: `kind 'project'` (visible) or `kind 'interest'` (hidden backing project). A visible project has a **workflow**: `research` (the research stage), `code`, or a custom workflow. `feed` is no longer offered for visible projects; the built-in `feed` workflow remains and is used only by interest backing projects.
- **Interest**: an org-level statement of a topic. It has:
  - an active tick, label and description;
  - preferred sites and a sub-category;
  - a domain (work or personal: which vault, and where it ranks in priority);
  - a scan cadence and max items;
  - kinds (article, video, podcast);
  - taste rules and a research option;
  - assigned agents;
  - one backing project.
- **Run**: one firing of an interest. A `scan` run is a feed card (scout, then curator). A `research` run is a research card (researcher, then checker). A scan can trigger a research run.
- **Schedule**: a trigger with an action. It is never a feed.
- **Agent**: belongs to one org. It works any project of that org whose members include its workstation's owner.

---

## 2. Data model and migrations

### 2.1 `1310_org_agents.sql`

```sql
-- Agents belong to the organization (docs/design/restructure.md D7-D9). project_id becomes history only.
ALTER TABLE agents RENAME COLUMN project_id TO hired_for_project_id;   -- the project the agent was hired for, if any; never used for eligibility
ALTER TABLE agents ADD COLUMN focus_project_ids uuid[] NOT NULL DEFAULT '{}';  -- soft preference (AgentFocusSet)
ALTER TABLE projects ADD COLUMN preferred_skills text[] NOT NULL DEFAULT '{}';  -- soft preference for agents with these skills
```

Data:
- Every agent with `project_id` set gets `focus_project_ids = ARRAY[project_id]`. This keeps today's behaviour as a preference. The SQL migration does the update. The projector of `AgentHired{projectId}` sets the same value, so a rebuild matches.
- No agent changes org. Guest-hired agents already have `org_id` = the owner's org.

### 2.2 `1311_schedule_actions.sql`

```sql
-- Generic schedules (D10): a cron trigger and an action.
ALTER TABLE schedules ALTER COLUMN project_id DROP NOT NULL;          -- org-level actions (devops, integration, ba_task without project)
ALTER TABLE schedules ADD COLUMN action jsonb;                       -- ScheduleAction; NULL only for legacy rows before backfill
ALTER TABLE schedules ADD COLUMN owner_user_id uuid REFERENCES users(id);  -- who created it (workstation actions run as this user)
ALTER TABLE schedules DROP CONSTRAINT schedules_kind_check;
ALTER TABLE schedules ADD CONSTRAINT schedules_kind_check
  CHECK (kind IN ('feed','regression','card','devops_request','ba_task','integration'));
UPDATE schedules SET action = CASE kind
    WHEN 'regression' THEN jsonb_build_object('kind','regression_run','projectId',project_id,'template',card_template)
    ELSE jsonb_build_object('kind','create_card','projectId',project_id,'template',card_template) END
  WHERE action IS NULL;
```

`kind` stays as a denormalized action kind for filtering (`card` = `create_card`). `feed` rows are removed by the data migration (§5.4). The projector writes `action` from the event, or derives it from `kind` + `cardTemplate` for legacy events, so a rebuild matches.

### 2.3 `1312_project_stage.sql`

```sql
-- Research stage and conversion (D11).
ALTER TABLE projects
  ADD COLUMN started_as   text,          -- workflow key at creation ('research' for research-first projects)
  ADD COLUMN converted_at timestamptz,   -- last ProjectConverted
  ADD COLUMN converted_by uuid REFERENCES users(id);
UPDATE projects SET started_as = workflow_key WHERE started_as IS NULL;
```

### 2.4 `1313_interests_org.sql`

```sql
-- Org-level interests (D1-D6).
ALTER TABLE projects
  ADD COLUMN kind     text NOT NULL DEFAULT 'project' CHECK (kind IN ('project','interest')),
  ADD COLUMN vault_dir text;   -- full vault-relative folder (e.g. 'interests/rust-async'); NULL = projects/<vault_folder or key>
CREATE INDEX projects_visible ON projects (org_id) WHERE kind = 'project';

ALTER TABLE interests
  ADD COLUMN project_id        uuid REFERENCES projects(id),   -- backing project (kind 'interest'); NOT NULL once migrated
  ADD COLUMN slug              text,                            -- vault folder name, immutable
  ADD COLUMN domain            text CHECK (domain IN ('work','personal')),
  ADD COLUMN kinds             text[] NOT NULL DEFAULT '{article,video,podcast}',
  ADD COLUMN research          jsonb NOT NULL DEFAULT '{"enabled":false}',  -- ResearchSpec
  ADD COLUMN agents            jsonb NOT NULL DEFAULT '{}',     -- {scout?, curator?, researcher?, checker?}: agent ids
  ADD COLUMN taste_rules       jsonb NOT NULL DEFAULT '[]',     -- string[] (max 100, 1..500 chars)
  ADD COLUMN taste_version     integer NOT NULL DEFAULT 0,
  ADD COLUMN next_scan_at      timestamptz,
  ADD COLUMN next_research_at  timestamptz,
  ADD COLUMN fail_count        integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error        text,
  ADD COLUMN failure_desk_item_id uuid,
  ADD COLUMN archived_at       timestamptz;
ALTER TABLE interests RENAME COLUMN feed_project_id TO legacy_feed_project_id;
ALTER TABLE interests RENAME COLUMN research_project_id TO legacy_research_project_id;
ALTER TABLE interests RENAME COLUMN schedule_id TO legacy_schedule_id;
ALTER TABLE interests DROP CONSTRAINT interests_check;          -- "feed or research project" no longer applies
CREATE UNIQUE INDEX interests_slug ON interests (org_id, slug) WHERE slug IS NOT NULL;
CREATE UNIQUE INDEX interests_project ON interests (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX interests_due ON interests (next_scan_at) WHERE status = 'active' AND archived_at IS NULL;

CREATE TABLE interest_runs (
  id            uuid PRIMARY KEY,
  interest_id   uuid NOT NULL,
  org_id        uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN ('scan','research')),
  trigger       text NOT NULL CHECK (trigger IN ('cron','manual','after_scan','migrated')),
  card_id       uuid NOT NULL,
  parent_run_id uuid,                       -- research run started by a scan
  status        text NOT NULL CHECK (status IN ('queued','scanning','curating','researching','checking',
                                                 'published','nothing','failed','cancelled')),
  found         integer,                    -- scout candidates (NULL for migrated runs: not recorded)
  published     integer,                    -- digest items or notes
  duplicates_dropped  integer,
  over_max_dropped    integer,
  started_by    uuid REFERENCES users(id),  -- manual runs
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz
);
CREATE INDEX interest_runs_interest ON interest_runs (interest_id, started_at DESC);
CREATE UNIQUE INDEX interest_runs_card ON interest_runs (card_id);

ALTER TABLE cards ADD COLUMN interest_run_id uuid;
ALTER TABLE cards ADD COLUMN preferred_agents jsonb;   -- {roleKey: agentId}, soft pin (§4.3)
ALTER TABLE cards DROP CONSTRAINT cards_origin_check;
ALTER TABLE cards ADD CONSTRAINT cards_origin_check
  CHECK (origin IN ('manual','intake','schedule','test_failure','full_suite','regression','interest'));

CREATE TABLE data_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL, report jsonb NOT NULL);  -- not a projection
```

- Add `interest_runs` to `PROJECTION_TABLES`. `data_migrations` is **not** a projection: a rebuild replays the events the data migration appended, and the row only stops the migration running twice.
- `taste_seeds` stays, read-only after the migration, for history. The final step of the plan drops it.
- `ResearchSpec = {enabled: boolean, cadence: 'after_scan' | 'cron' | 'manual', cron?, timezone?, depth: 'quick'|'standard'|'deep', question?: string}`.
- `ScanSpec` (existing) gains nothing. `scan.manual` means no cadence. "Active tick" is `status` (`active`/`paused`). `archived_at` is set by delete (soft).

### 2.5 Helpers in `packages/shared`

- `vaults/index.ts`: `projectVaultFolder({key, vaultFolder, vaultDir})` returns `vaultDir` when it is set. Every server and runner caller already goes through this helper or receives the folder in the brief. Check `apps/runner/src/transcript/service.ts` and `research/publish.ts`: they must use the folder from the brief, never a hard-coded `projects/`.
- `interests/index.ts`: `interestSlug(name, taken)`, `interestBackingKey(slug, takenKeys)` (2 to 10 chars `^[A-Z][A-Z0-9]+$`, from the slug, with a numeric suffix on collision), `interestCardTemplate` (adds `kinds`), `researchRunFields(interest, digestItems?)`, `nextScanAt(scan, now)`, `nextResearchAt`.

---

## 3. Events

All new payload fields are optional, so older events still parse on replay.

### 3.1 Agents (`events/agent.ts`)

| Event | Payload | Projection |
| --- | --- | --- |
| `AgentHired` | `projectId` kept optional (deprecated). New: `focusProjectIds?: Id[]` | `hired_for_project_id = projectId`; `focus_project_ids = focusProjectIds ?? (projectId ? [projectId] : [])` |
| `AgentFocusSet` (new) | `{agentId, projectIds: Id[] (max 10), by}` | `focus_project_ids` |
| `ProjectSkillsSet` (new, `events/project.ts`) | `{projectId, skills: string[]}` | `projects.preferred_skills` |

Agent events are scoped `orgScope(orgId)`. Before, a project-scoped agent's events used `projectScope`. Live updates for guest members are covered in §7.4.

### 3.2 Schedules (`events/schedule.ts`)

- `ScheduleCreated` and `ScheduleUpdated` gain `action?: ScheduleAction` and `ownerUserId?`. `projectId` becomes `Id.nullable()`. `cardTemplate` becomes optional (legacy).
- `ScheduleFired`: `cardId` becomes optional, and `result?: {cardIds?, devopsRequestId?, baTaskId?, commandId?}` is added.
- `ScheduleKind` gains `devops_request`, `ba_task` and `integration`. `feed` stays for replay. Creating a `feed` schedule is refused with 400 `use_interests`.

```ts
ScheduleAction = discriminatedUnion('kind', [
  {kind:'create_card',    projectId, template: CardTemplate, specify: boolean (default true)},
  {kind:'regression_run', projectId, template: CardTemplate},                     // fields.platform
  {kind:'devops_request', workstationId, text (1..2000), hygiene?: boolean},       // hygiene = "run repo hygiene now"
  {kind:'ba_task',        projectId: Id|null, prompt (1..2000), deliver: 'desk_notice'|'chat'},
  {kind:'integration',    workstationId, integration: 'github'|'jira', operation: 'issues_poll',
                          query (1..500), projectId},                              // new tickets -> intake for the BA
])
```

`{date}` and `{week}` in a template title are expanded at fire time, in the schedule's timezone. The current "title + date" behaviour becomes the default `"<title> {date}"`.

### 3.3 Projects (`events/project.ts`)

| Event | Payload | Projection |
| --- | --- | --- |
| `ProjectCreated` | adds `kind?: 'project'|'interest'`, `vaultDir?: string`, `members?: [{userId, role}]` (interest backing projects copy members) | columns; `started_as = workflowKey` |
| `ProjectConverted` (new) | `{projectId, fromWorkflowKey, toWorkflowKey, openResearchCards: 'keep'|'cancel', cancelledCardIds: Id[], note?: string, by}` | `workflow_key`, `converted_at`, `converted_by` |
| `ProjectKindChanged` (new, data migration only) | `{projectId, kind:'interest', interestId}` | `projects.kind` |

The repos added at conversion use the existing repo-added event in the same append. Cancelled research cards use `CardCancelled` in the same append.

### 3.4 Interests (`events/interest.ts`)

Stream `interest-<id>`, scope `projectScope(orgId, interest.projectId)`, so visibility follows the backing project's members.

| Event | Payload | Projection |
| --- | --- | --- |
| `InterestCreated` / `InterestUpdated` | `InterestBody` v2: `{interestId, orgId, projectId, slug, domain, name, description, subCategory, preferredSites, kinds, scan, research, agents, status, nextScanAt, nextResearchAt}` plus the v1 fields as optional legacy fields (`feedProjectId`, `researchProjectId`, `scheduleId`, `adoptedFrom`) | upsert `interests`. A v1 payload (no `projectId`) maps to `legacy_*` columns |
| `InterestArchived` / `InterestRestored` (new) | `{interestId, by}` | `archived_at`. The backing project is archived and restored in the same append |
| `InterestDeleted` | unchanged. It is used only together with a permanent `ProjectDeleted` of the backing project | delete row |
| `InterestTasteSet` (new) | `{interestId, version, rules: string[]}` | `taste_rules`, `taste_version`. The taste hook writes the vault section |
| `InterestRunStarted` (new) | `{runId, interestId, kind, trigger, cardId, parentRunId?, startedBy?, nextScanAt?, nextResearchAt?}` (always appended with its `CardCreated{interestRunId, origin:'interest'}`) | insert `interest_runs` (`queued`); `interests.next_*`; `fail_count=0` |
| `InterestRunFailed` (new) | `{interestId, kind, attempts, error, nextScanAt, deskItemId?}` (the card could not be created: project archived, workflow missing) | backoff, like `ScheduleFireFailed` |
| `InterestMigrated` (new, data migration) | `{interestId, projectId, slug, domain, fromFeedProjectId?, fromScheduleId?, cardFilter: {projectId, scheduleId?, untaggedFeedCards: boolean}, copySeenFrom?: Id}` | sets `project_id`, `slug`, `domain`. Back-fills `cards.interest_id` with the filter, then inserts `interest_runs` (`trigger 'migrated'`) for those cards, with status derived from the card and `published` from `digest_items` / `research_publications`. This is deterministic on replay because those rows come earlier in the log |

The run projector also reacts to existing card events when `cards.interest_run_id` is set (`projections/interest-runs.ts`):

| Card event | Run effect |
| --- | --- |
| `ClaimGranted` / shift start in stage `scan` / `research` | `scanning` / `researching` |
| `StageCompleted` scan→curate (`data.candidates`) | `found = items.length`, `curating` |
| `StageCompleted` research→factcheck | `checking` |
| `DigestPosted` | `published = items.length`, dropped counts, `nothing` when `nothingQualified` else `published`, `finished_at` |
| `ResearchPublished` | `published = published + 1`, `published`, `finished_at` |
| `CardCancelled` | `cancelled` |
| `CardMovedByManager` to done without output | `nothing` |

`failed` is set when the loop breaker defers the card (`CardRetryDeferred` with `newEpisode`). It returns to the stage status on the next `HandoffWritten`.

### 3.5 Cards

`CardCreated` gains `interestRunId?` and `preferredAgents?: Record<roleKey, agentId>`.

---

## 4. Agents and the dispatcher

### 4.1 Eligibility (`apps/server/src/dispatcher/candidates.ts eligibility()`)

```ts
scope: `c.org_id = ${A.orgId} AND EXISTS (
          SELECT 1 FROM project_members pm
           WHERE pm.project_id = c.project_id AND pm.status = 'active'
             AND pm.user_id = (SELECT w.user_id FROM workstations w WHERE w.id = ${A.workstationId}))`,
preferred: `(c.preferred_agents IS NULL OR NOT (c.preferred_agents ? st.claim_role)
             OR c.preferred_agents->>st.claim_role = ${A.id}::text
             OR c.queued_at < ${A.now} - interval '10 minutes'
             OR NOT EXISTS (SELECT 1 FROM agents pa JOIN workstations pw ON pw.id = pa.workstation_id
                             WHERE pa.id = (c.preferred_agents->>st.claim_role)::uuid AND pa.status = 'active'
                               AND pw.connected AND pw.last_seen_at > ${A.now} - interval '45 seconds'))`,
```

- `AgentView.projectId` and `AgentRefs.projectId` are removed. `AgentRefs` gains `now` (the dispatcher binds `$9`; workability binds `now()`).
- The membership is that of the **workstation's user**, which is the agent's manager. For a guest's agent this limits it to the projects the guest shares. For the owner's agents it means every org project, because the owner has an `owner` row in each.
- The vault clause is unchanged. It already stops a guest workstation from taking the owner's personal-vault research.
- Hidden interest projects have members like any project (§5.2), so the owner's scouts and curators reach them through the same rule.

### 4.2 Ordering

```sql
ORDER BY
  c.scheduled DESC,                                              -- 1 scheduled and interest runs first
  (p.domain = 'work') DESC,                                      -- 2 work before personal
  CASE ... rework/bug own builder ... END,                       -- 3 unchanged
  (c.project_id = ANY ($10::uuid[])) DESC,                       -- 4 NEW: agent focus projects
  p.priority_tier ASC,                                           -- 5 project tier
  (SELECT count(*) FROM unnest(p.preferred_skills) s WHERE s = ANY ($11::text[])) DESC,  -- 6 NEW: skill overlap
  c.priority ASC, c.queued_at ASC, c.created_at ASC
```

`$10 = agent.focus_project_ids` and `$11 = agent.skills`. Focus goes ahead of tier because it is an explicit manager instruction for that agent. An agent with no focus is ordered by tier as today. Capacity stays per agent (`active < capacity`), and overflow stays one per org.

### 4.3 Preferred agents (interest assignments)

`interests.agents` turns into `cards.preferred_agents` on every run card. For 10 minutes after the card is queued in a stage, only the preferred agent of that stage's role may claim it, unless that agent is retired, needs a rehome or is offline. After that any eligible agent may claim it. The overflow pass (§9.4) tries the preferred agent first. The 10 minutes is the constant `PREFERRED_AGENT_GRACE_MS` in `packages/shared/src/interests`. Spec rule 1 still holds: the card is created on time.

### 4.4 Other readers of `agents.project_id` (all change)

| File | Change |
| --- | --- |
| `dispatcher/ba-tasks.ts:48` `(a.project_id IS NULL OR a.project_id = $2 OR $4)` | Replace with the membership rule on the task's project (or the org for `floor_report`). The intake's BA is still preferred |
| `dispatcher/bottleneck.ts` tester lookup | Testers whose workstation user is an active member of the project |
| `queries/agents.ts listAgents` | Visible: `a.org_id = $user OR a.manager_user_id = $user OR EXISTS (a project of a.org_id where both $user and the agent's workstation user are active members)`. The `projectId` filter becomes "eligible for this project" (the same EXISTS on that project) |
| `commands/agents.ts manageableAgent`, `authz canDirectAgent` | Direct or chat: the org owner, the manager, or a member who shares a project with the agent's workstation user (chat thread linked to that project, as now) |
| `hr/hr.ts:258` | DTO `hiredForProjectId`, `focusProjectIds`, and `eligibleProjects` (count plus the first 5 keys) |
| `reporter/reporter.ts:207`, `reporter/routing.ts baAvailable` | "Within the agent's project scope" becomes the membership rule |
| `queries/workability.ts` | Picks up the new `eligibility()`, with no code of its own |
| `commands/projects.ts deleteProject` | Remove the `AgentRetired` loop and `agent.wipe` (D9). Update the doc comment |
| `projections/projects.ts deleteProjectRows` | `UPDATE agents SET focus_project_ids = array_remove(focus_project_ids, $1)` |
| `projections/sharing.ts ProjectMemberRemoved` | Re-home the removed member's agents in that org **only if** the member has no other active membership in the org. Otherwise leave them: they just stop qualifying for this project. Release claims on this project's cards in both cases (`ClaimReleased(member_removed)`), and drop the project from their focus |

### 4.5 Hiring

- `HireAgentRequest`: `projectId?` is replaced by `orgId?` (default: the caller's own org) and `focusProjectIds?`. `projectId` is still accepted for one release as an alias: `orgId = project.org_id`, `focus = [projectId]`.
- `canHireAgent({userId, orgId, isOrgMember})`: the owner, or any org member (a guest of at least one active shared project). It is refused when the guest has no active project in that org (409 `no_shared_project`). The workstation must be the caller's own, as today.
- `PUT /api/agents/:id/focus {projectIds}` → `AgentFocusSet`. Allowed for `canManageAgent`. Every project must be one the agent qualifies for (400 `focus_not_eligible`).
- `PUT /api/projects/:id/skills {skills}` → `ProjectSkillsSet`. Allowed for any project member.

### 4.6 Shared projects across users

| Case | Result |
| --- | --- |
| Owner A shares project W with guest B | A's agents (on A's machines) and B's agents hired into A's org (on B's machines) both work W. B's agents never work A's unshared projects |
| B is a guest on two of A's projects | B's agents in A's org work both, with no second hire needed |
| B hires in B's own org | Those agents never work A's projects (different org). Lending agents across orgs is out of scope (Q10) |
| A removes B from W, and B still has V in A's org | B's agents keep working V. Claims on W are released |
| A removes B from the last project | Today's behaviour: the agents move to A with `needs_rehome` |

---

## 5. Interests

### 5.1 Authorization

| Action | Allowed for |
| --- | --- |
| List and view interests, runs, digests, transcripts, taste | active members of the backing project |
| Create | any user, in their own org (the creator becomes owner of the backing project). An org member (guest) may create in the owner's org only for the `work` domain: the backing project gets members owner and guest (Q3) |
| Edit, pause or resume, set agents, taste rules, resync, run now, research now, archive or restore, rate items | any active member of the backing project (owner decision 11/12) |
| Share an interest | owner of the backing project, through the existing project invitation on that project (`POST /api/interests/:id/members` delegates to it) |
| Delete permanently | owner of the backing project, after archive (type the slug) |
| Assign an agent | the agent must belong to the interest's org and qualify for the backing project (§4.1); 400 `agent_not_eligible` otherwise |

A member of a project other than the backing project gets 404, as today. Project routes (`PATCH /api/projects/:id`, archive, delete, repos, phases, schedules) refuse a backing project with 409 `managed_by_interest`, with `details.interestId`.

### 5.2 Commands (`apps/server/src/commands/interests.ts`, rewritten)

- `createInterest(ctx, user, req)`, all in one `withAppendTx`:
  1. `slug = interestSlug(name)`, unique per org. `key = interestBackingKey(slug)`, free per org.
  2. `ProjectCreated{kind:'interest', workflowKey:'feed', domain, key, name, vaultDir: 'interests/<slug>', priorityTier: 2, members}`.
  3. `InterestCreated{projectId, nextScanAt: nextScanAt(scan, now) unless manual or paused, nextResearchAt}`.
  4. `InterestTasteSet{version 1}` when rules are given.
  5. A `vault.write` (section `interest`) of `INTEREST.md` (§6) after the commit.
- `updateInterest`: full snapshot. Recompute `next_*` when the cadence or status changes (as in `scheduleUpdateEvent`). Name changes keep the slug. `domain` is immutable after the first run (400 `domain_locked`; Q5).
- `setInterestTaste(interestId, rules)`: lock the row, dedupe, `version + 1`.
- `resyncTaste`: re-issues the section write for the current version. This is the "Resync taste.md" button (owner decision 12).
- `runInterest(interestId, kind, user)` and the cadence path `fireDueInterests(ctx)` (scheduler tick, `FOR UPDATE SKIP LOCKED LIMIT 20` on `interests_due`) share `interestRunEvents(tx, interest, kind, trigger, now)`:
  - `InterestRunStarted` + `CardCreated{projectId: interest.project_id, cardType, origin:'interest', scheduled:true, status:'queued', interestId, interestRunId, preferredAgents, fields}`.
  - Scan fields come from `interestCardTemplate(interest)`, adding `kinds`.
  - Research fields come from `researchRunFields(interest)`: question from `research.question` or "What should I know now about <name>?", scope = description, depth, subCategory, preferredSites.
  - Errors produce `InterestRunFailed` with `scheduleBackoffMs`. The third failure in a row opens an alert desk item (`interest_failing`), reusing the schedule failure notice code.
  - A manual run while a run of the same kind is queued or running answers 409 `run_in_progress` with its card ref. Cron runs skip a fire when one is still running and log `InterestRunFailed{error:'previous_run_active'}` without counting a failure.
- **After-scan research:** in `commands/feeds.ts buildDigestEvents`, when the card has `interest_run_id`, the interest has `research.enabled && cadence === 'after_scan'`, and the digest is not `nothingQualified`, append `interestRunEvents(kind 'research', trigger 'after_scan', parentRunId)` in the same append. The research card's fields carry `seedSources: [{title, url}]`, the digest's items, which the researcher starts from.
- `archiveInterest` / `restoreInterest`: `InterestArchived` + `ProjectArchived` of the backing project (cancels queued run cards as archive does today).
- **"Research this" into a regular project**: still `POST /api/cards {projectId, cardType:'research', interestId}`. The interest must be visible. Its id is recorded on the card, and the run log lists it as an external note (no run row).

### 5.3 Run lifecycle

```
cadence due / Run now / after_scan
  -> InterestRunStarted + CardCreated(feed|research, preferredAgents)      run: queued
  -> scout claims scan                                                      run: scanning
  -> StageCompleted{candidates}                                             run: curating, found=N
  -> curator: DigestPosted{items, nothingQualified, dropped...}              run: published (M items) | nothing
       -> DigestPosted hook (taste.ts): feed.md append in <interest folder>
       -> desk rating item (as today); ItemRated -> taste.md rating line in <interest folder>
       -> [research.after_scan] InterestRunStarted(research, parent) + research card
  -> researcher -> StageCompleted                                           run: checking
  -> checker: ResearchPublished (note in <interest folder>/notes/)          run: published (+1)
  card cancelled / loop back-off                                            run: cancelled / failed
```

The run log entry shows:
- trigger, start, duration, status;
- found → published (and dropped duplicates or over-max);
- ratings (useful, irrelevant, boring, unrated, joined from `digest_items`);
- the items with their media-transcript status (`digest_items.transcript`, text from `transcripts`);
- the agents' shift logs (existing `ShiftLog` per shift of the card);
- notes published (`research_publications`);
- the child research run.

### 5.4 Data migration `restructure-2026-10` (`apps/server/src/data-migrations/restructure.ts`)

It runs once at boot, after the SQL migrations and before the dispatcher and scheduler start, under `pg_advisory_lock(7331)`. It is skipped when `data_migrations` has the id. Each org runs in its own transaction, so one bad org does not block the rest. The actor is `system` with reason `restructure-2026-10`. The per-org report (counts and warnings) is stored in `data_migrations.report` and posted once as an `alert` desk item to each affected owner ("Feed projects became interests").

For each org, for each **feed project P** (`workflow_key = 'feed'`, `kind='project'`), whether active or archived:

1. Collect P's **sources**, in this order:
   - the interests with `feed_project_id = P`, by `created_at`;
   - then P's unlinked feed schedules (`interest_id IS NULL`), each becoming a new interest (name `unique(topic ?? schedule.name)`; fields mapped as in interests.md adopt);
   - when P has neither, one interest named after P, `paused`, `scan.manual = true`.
2. **First source**: P itself becomes the backing project. Append `ProjectKindChanged{P, 'interest', interestId}` (vault folder unchanged, `vault_dir` NULL so `projects/<folder>`), then `InterestMigrated{projectId: P, cardFilter: {projectId: P, untaggedFeedCards: true}}`. Every feed card of P with no `interest_id` (cards from manual runs and old schedules) is attributed to the first interest. Other interests' tagged cards stay theirs.
3. **Further sources**:
   - `ProjectCreated{kind:'interest', key: interestBackingKey, workflowKey:'feed', domain: P.domain, vaultDir: 'interests/<slug>', members: P's active members}`;
   - `InterestMigrated{projectId: new, cardFilter: {projectId: P, scheduleId}}`. Their history stays in P. Runs and stats join on `cards.interest_id`, so the history is whole.
   - `feed_seen` is a projection, so the copy is done by the `InterestMigrated` projector (payload `copySeenFrom: P`), which keeps it rebuild-safe. `transcripts` is not a projection (runner rpc), so the data migration copies P's rows to the new project with plain SQL in the same transaction.
4. **Taste**: for each interest, `InterestTasteSet{rules: untagged rules of P's taste_seeds + rules tagged with this interest}`. For further interests (new folders), also queue one `vault.write {mode:'section', section:{id:'imported', version:1}}` into `interests/<slug>/taste.md`. It holds the rating lines re-rendered (`renderTasteEntry`) from every rated `digest_items` row of P, because those ratings shaped the project-wide taste the interest ran under. The first interest keeps P's `taste.md` as is.
5. **Interest v2 snapshot**: `InterestUpdated` with `domain = P.domain`, `slug`, `kinds` (all), `research` (enabled `false`; enabled with `cadence:'manual'` when the interest had a `research_project_id`), `agents` (the scout and curator of P's agents with `focus` on P, if exactly one of each), `status` and `nextScanAt` from the schedule.
6. **Schedules**: `ScheduleDeleted` for every feed schedule of P (linked or adopted). Non-feed schedules of P (rare) are kept; the report warns.
7. **Research-only interests** (`feed_project_id IS NULL`): a new backing project as in step 3, `scan.manual = true`, `research.enabled` with `cadence: 'manual'`. `InterestMigrated{cardFilter: none}`, so cards in the research project keep `interest_id` and appear as external notes.
8. P keeps its key, cards, refs, digest history, ratings, desk items, transcripts and taste. It disappears from project lists because it is now `kind='interest'`.

After all orgs: `UPDATE interests ... project_id NOT NULL` is not enforced in SQL (old event replays). A server test asserts that no non-archived interest has a NULL `project_id` after the migration.

Idempotency: every step checks the current state (P already `kind='interest'`, interest already has `project_id`), so a crash halfway resumes safely on the next boot.

### 5.5 Taste flow

- **Brief** (`runner-gateway/brief.ts`): `feed.tasteSeed = interest.taste_rules` for cards with `interest_id`. Legacy cards without an interest use P's `taste_seeds` (read-only). `feed.taste` is the `taste.md` of the card's project folder (unchanged code: folder = backing project), with the `seed` section stripped (the brief carries those rules). The `imported` section is kept and passed on as "Earlier ratings (imported)", so the curator still reads that history: `stripManagedSection(text, {keep: ['imported']})`.
- **Ratings** (`commands/taste.ts`): `ItemRated` goes to the folder of the interest's backing project via `digest_items.card_id → cards.interest_id → interests.project_id`. It falls back to the item's project. This matters only for migrated history kept in P while the interest moved to a new backing project.
- **Seed section**: `InterestTasteSet` → `section 'seed'` in `<folder>/taste.md`, header `TASTE_HEADER`, content `renderTasteSeedSection(rules)` with no per-interest sub-headings.

---

## 6. Vault layout

In the org's `work` or `personal` vault (the interest's `domain`):

```
interests/<slug>/
  INTEREST.md            managed section 'interest': label, description, sites, cadence, kinds, research option, agents
  feed.md                running digest list, oldest to newest (append, unchanged renderer)
  taste.md               managed 'seed' (explicit rules) + ['imported'] + rating lines
  runs.md                one appended line per finished run: date, trigger, found -> published, card ref
  transcripts/<date>-<slug>.md
  notes/<date>-<slug>.md research notes (or <sub-category>/ when set, as research publish does today)
```

Migrated first interests stay in `projects/<old folder>/` with the same files (`feed.md`, `taste.md`, `transcripts/`). Their `INTEREST.md` and `runs.md` are written there. Q6 covers a later "Move folder". Visible projects are unchanged (`projects/<folder>/`). A converted research project keeps its folder and notes. Conversion adds a managed `research-index` section to its `PROJECT.md` that lists its published notes (§8.3).

---

## 7. API and web

### 7.1 REST

| Method and path | Purpose |
| --- | --- |
| `GET /api/interests?status=&archived=` | list with stats (existing CTE regrouped by `interests.id`; adds `lastRun`, `nextScanAt`, `failing`) |
| `GET /api/interests/:id` | detail: interest, stats, taste, agents (names, online), backing project key, vault folder and whether a vault is registered |
| `POST /api/interests` | `{name, description?, domain, subCategory?, preferredSites?, kinds?, scan, research?, agents?, tasteRules?, status?}` |
| `PATCH /api/interests/:id` | partial of the above (`domain` refused after the first run) |
| `POST /api/interests/:id/archive` · `/restore` · `DELETE /api/interests/:id {confirmSlug}` | soft and permanent delete |
| `POST /api/interests/:id/run {kind:'scan'|'research'}` | run now → `{runId, cardId, ref}` |
| `GET /api/interests/:id/runs?before=&limit=` | run log page: `InterestRunDto[]` `{id, kind, trigger, status, startedAt, finishedAt, found, published, dropped, ratings:{useful, irrelevant, boring, unrated}, card:{id, ref}, parentRunId, childRunIds}` |
| `GET /api/interests/:id/runs/:runId` | run detail: items (verdict, reason, transcript status), notes, shifts `[{id, role, agentName, status, startedAt, endedAt}]` (logs through the existing shift log endpoint) |
| `GET /api/interests/:id/digest?unrated=` | the running list across all the interest's runs (replaces `/p/:key/feed`) |
| `PUT /api/interests/:id/taste {rules}` · `POST /api/interests/:id/taste/resync` | taste |
| `GET /api/interests/:id/agents/eligible` | scouts, curators, researchers and checkers that qualify |
| Removed | `GET /api/interests/adoptable`, `POST /api/interests/adopt`, `newFeedProject`, `feedProjectId`/`researchProjectId` (400 `field_removed`), `PUT/GET /api/projects/:id/taste-seed` (410 `moved_to_interest`), `POST /api/schedules/:id/run` and `/projects/:id/schedules/run-all` for feeds (410) |
| Schedules | `POST/PATCH /api/schedules` take `{name, trigger:{cron, timezone, manual}, action}`; `GET /api/schedules?projectId=&kind=` is org-level (projects the user is a member of plus org-level schedules of their own org); `POST /api/schedules/:id/run` works for every action |
| Projects | `POST /api/projects` `workflowKey` refuses `feed` (400 `use_interests`). `POST /api/projects/:id/convert` (§8). `PUT /api/projects/:id/skills`. Lists exclude `kind='interest'` |
| Agents | `POST /api/agents {orgId?, focusProjectIds?}`, `PUT /api/agents/:id/focus` |

`listProjects`, the project switcher, `loadVisibleProject` used by board, settings and phase routes, metrics, the reporter's "oldest active project" fallback, intake mapping candidates and the BA's project lists all filter `kind = 'project'`. They go through one SQL helper `VISIBLE_PROJECT_KIND = "p.kind = 'project'"` and are covered by a test (§9). Card detail (`/cards/:ref`) works for interest cards: the breadcrumb shows "Interest: <name>" and links to `/interests?open=<id>`.

### 7.2 Interests page (`/interests`, Knowledge section)

List (desktop):

```
+--------------------------------------------------------------------------------------+
| Interests                                                        [+ New interest]    |
| What you follow. Each interest scans on its own cadence and learns from your ratings. |
| [Active v] [All domains v]  Search [____________]                    [Show archived] |
+--------------------------------------------------------------------------------------+
| [x] Rust async                    personal · rust/async          Daily 07:00 SAST     |
|     Last run 07:02 today: found 14 -> 6 published · 2 unrated   next tomorrow 07:00   |
|     Scout: Sid · Curator: Cleo · Research: after each scan (Rhea, Chen)              |
|     [Run scan] [Research now] [Digest] [Run log]                         [Open ->]   |
+--------------------------------------------------------------------------------------+
| [ ] Reloading powders             personal · shooting/reloading  Manual only  Paused  |
|     Last run Sep 30: research note published                                         |
|     [Run scan] [Research now] [Digest] [Run log]                         [Open ->]   |
+--------------------------------------------------------------------------------------+
| ! AI agents weekly: cannot run (3 tries): no curator online.   [Open run log]        |
+--------------------------------------------------------------------------------------+
```

The leading `[x]` is the active tick: it toggles active and paused, which is `PATCH {status}`.

Detail (`/interests?open=<id>`: a full page on mobile, a wide right panel of 720 px on desktop, with tabs):

```
+----------------------------------------------------------------------------------+
| <- Interests   Rust async                       [x] Active   [Run scan] [Research]|
| personal · interests/rust-async · RUSTA                                [...]      |
| [Settings] [Run log] [Digest] [Taste] [Notes]                                     |
+----------------------------------------------------------------------------------+
| RUN LOG                                                     Filter [All kinds v]  |
|----------------------------------------------------------------------------------|
| v Oct 6 07:00  Scan · cron        published  found 14 -> 6  (dup 3, over max 5)    |
|     Ratings: useful 3 · boring 1 · unrated 2          RUSTA-41  6m 12s             |
|     Items                                                                          |
|      1 [article] Tokio 2.0 scheduler notes - tokio.rs         useful               |
|      2 [video]   Async traits deep dive - YouTube   transcript: 14k chars [view]   |
|      3 [podcast] Rustacean Station #160         transcript: none (said so)         |
|      ...                                                                           |
|     Agents   Sid (scout)  done 3m40s [shift log]   Cleo (curator) done 2m [log]    |
|     -> Research run Oct 6 07:07 (RUSTA-42)  checking                               |
| > Oct 6 07:07  Research · after scan  checking               RUSTA-42             |
| > Oct 5 07:00  Scan · cron        nothing qualified  found 9 -> 0   RUSTA-39       |
| > Oct 4 15:12  Scan · manual (Pieter)  failed: loop back-off   RUSTA-38 [release]  |
| > Sep 28       Scan · migrated    published 4               NEWS-17                 |
|                                                    [Load older]                    |
+----------------------------------------------------------------------------------+
```

The Settings tab is a form with a sticky Save:

```
| Label        [Rust async_____________________]                                   |
| Description  [markdown: angle, include/exclude, level ...]                       |
| Domain       (o) Personal ( ) Work   (locked after the first run)                |
| Sub-category [rust/async v]   Preferred sites [lobste.rs, without.boats]         |
| Cadence      [Daily at 07:00 v] [cron_____] Time zone [Africa/Johannesburg v]    |
|              Window [24] h   [ ] Manual only        Next: tomorrow 07:00         |
| Max items    [10] total across  [x] Article [x] Video [x] Podcast                |
| Research     [x] Deeper research   When (o) after each scan ( ) on a cadence     |
|              ( ) only when I click   Depth [Standard v]  Question [__________]   |
| Agents       Scout [Sid v]  Curator [Cleo v]  Researcher [Rhea v] Checker [any v]|
|              Preferred for 10 minutes, then any qualified agent.                 |
| Members      Pieter (owner) · Ana   [Share...]                                   |
```

The Taste tab:

```
| Explicit rules (come first, win on conflict)           Mirrored to taste.md v5   |
|  - Skip beginner tutorials                                       [edit] [x]       |
|  [+ Add rule__________________________________] [Add]                             |
|  [Resync taste.md]                                                                |
| From your ratings (read-only, newest first)                                       |
|  - Prefer articles like "Tokio 2.0 ..." from tokio.rs (useful)                    |
```

On mobile (< sm) each interest is a card. The actions wrap into 44 px buttons. The tabs become a select, and run rows expand in place.

### 7.3 Other pages

- **Nav** (`components/shell/nav-config.ts`): remove the `isFeed` option and the Feed entry. Knowledge keeps Interests, Ledger and Vaults. Work keeps Board, Desk, Intake, Schedules and Projects. `INTERESTS_NAV` stays for the test id.
- `/p/:key/feed`: redirects to `/interests?open=<interestId>&tab=digest` for a backing project key, otherwise to `/projects`. `pages/FeedProject.tsx` is removed. `DigestRating` and `Transcript` move under `components/interests/`.
- `/p/:key/board` for a backing project key redirects to the interest.
- **Projects page and new-project form**: types are **Research first**, **Code**, and the custom workflows. Feed is gone, with the hint "Following a topic? Create an interest." A "Research stage" badge appears on research projects.
- **Schedules page**: an org-level list grouped by action, with a New schedule wizard:

```
+------------------------------------------------------------------+
| New schedule                                                [x]  |
| 1 When   [Weekdays at 08:00 v] [cron____] [Africa/Johannesburg v] |
|          [ ] Manual only (Run now)          Next: Mon 08:00       |
| 2 Do     ( ) Create a card from a template                        |
|          ( ) Run regression suites                                |
|          ( ) Ask a DevOps engineer   ( ) Run repo hygiene         |
|          ( ) Give the BA a task      ( ) Poll GitHub / Jira       |
| 3 Details (depends on 2: project, template / workstation, text /  |
|          prompt, delivery / integration, query, target project)  |
|                                     [Cancel] [Create schedule]    |
+------------------------------------------------------------------+
```

  Read-only "System" rows show repo hygiene per workstation (link to Workstations) and the daily floor report (link to Settings), so every recurring job is visible in one place (Q8).
- **Agents and HR**: the hire form has an Organization select, shown only when the user is a guest somewhere, and an optional "Focus on projects" multi-select. The agent card shows "Works on: all N projects" or "N shared projects", the focus chips, and "Hired for <KEY>" as history. Project settings gets a "Preferred skills" input.

### 7.4 Live updates (`ws/invalidate.ts`)

- `InterestRunStarted`, `InterestRunFailed`, `InterestTasteSet`, `InterestArchived` and `InterestRestored` → `['interests']`, `['interest', id]`, `['interest-runs', id]`.
- Card events with `interest_run_id` → `['interest-runs', interestId]`. The browser has the card in cache, or invalidates `['interest-runs']` broadly.
- `ScheduleFired` → `['schedules']`.
- `AgentFocusSet` → `['agents']`.
- Agent events are now org-scoped, so a guest gets no live agent updates. The HR page refetches every 30 s and on focus (risk R5).

---

## 8. Research-stage projects and conversion

### 8.1 Research cards in any project

- `resolveCardWorkflow(tx, project, cardType)` in `commands/cards.ts` (new, used by `createCardIn`, `scheduledCard`, intake card drafts and `interestRunEvents`):
  1. Use the project's workflow if its `cardTypes` includes the type.
  2. Otherwise use the org-resolved workflow from `CROSS_PROJECT_CARD_TYPES = {research: 'research'}` (the `bug` → `code-bugfix` rule in `commands/testing.ts` stays as is).
  3. Otherwise 400 `invalid_card_type`.
- `CardNew` offers "Research" in every project's type select.
- **Board** (`packages/shared/src/cards/columns.ts`): columns are the project workflow's columns, plus the columns of other workflows present on open cards, inserted before the terminal column and de-duplicated by label. They appear only when such cards exist. Research cards show a "Research" chip.

### 8.2 Conversion

`POST /api/projects/:id/convert` `{toWorkflowKey, repos: [{repoId} | {name, remoteUrl} | {create: {name, visibility}}], openResearchCards: 'keep'|'cancel', setUpOn?: workstationId[], note?}`

- **Allowed for**: the project owner. The project must be `kind='project'`, active, with `workflow_key='research'`. `toWorkflowKey` must be `code` or an active custom workflow of the org (not `research` or `feed`).
- **Validation**: when the target workflow uses repos (`workflowUsesRepos`), at least one repository is required (400 `repo_required`). `{create}` reuses the repo-request path of `1103_repo_requests` and adds the repo when the request completes. The conversion waits in `converting` (Q7 default: refuse `{create}` in v1 and ask the user to create the repo first).
- **One append**:
  - `ProjectConverted`;
  - the repo-added events;
  - `CardCancelled{reason:'project converted'}` for open research cards when `cancel` was chosen;
  - `ProjectUpdated{subCategories}` is unchanged.
- **After commit**:
  - one DevOps setup request per `setUpOn` workstation (existing "Set up on <workstation>");
  - the branch-confirm question for each new repo with `reason 'conversion'` (owner decision 10: a new intake or phase also asks about repos with no working branch). Add `'conversion'` to `WorkingBranchReason`;
  - a `vault.write {mode:'section', section:{id:'research-index'}}` into `PROJECT.md` that lists the published notes (`research_publications` of the project), so every later shift reads the research.
- **Open research cards**:
  - `keep` (default): they finish on the research workflow and appear in the extra board columns.
  - Draft research cards stay drafts.
  - Phases with research members are unaffected.
- **History**: `ProjectConverted` shows on the project's activity feed and card-less timeline as "Converted from Research to Code by Pieter". Cards, refs, notes, ledger entries and the vault folder are untouched. `started_as` stays `research`.
- **Not supported**: converting back to research, or converting a code project to another workflow. Those stay on `PATCH workflowKey`, which this design removes from the settings form (400 `use_convert` for research-stage projects; Q12).
- **Repos while in the research stage**: `addRepo` refuses with 409 `research_stage_no_repos` ("Convert the project first"). A research project that already has repos (legacy) keeps them, with a warning on settings.

### 8.3 UI: convert dialog (project settings "Stage" panel, and a "Convert to project" button on the research-stage board header)

```
+----------------------------------------------------------------+
| Convert RELOAD to a delivery project                      [x]  |
|----------------------------------------------------------------|
| RELOAD started as Research on Sep 2. 7 notes published,        |
| 2 research cards open.                                         |
|                                                                |
| 1 Workflow   (o) Code   ( ) Support triage (custom)            |
| 2 Repos      [github.com/pieter/reload-calc______] [+ Add]      |
|              Set up on  [x] Desk-PC  [ ] Laptop                 |
| 3 Open research cards                                          |
|              (o) Keep them running (they finish as research)   |
|              ( ) Cancel them                                   |
| 4 Hand-over  Research notes are linked from PROJECT.md so      |
|              every agent reads them.                           |
|              [x] Start an intake with the BA from these notes  |
| Note (optional) [______________________________]               |
|----------------------------------------------------------------|
| This cannot be undone. Cards, notes and history are kept.      |
|                                   [Cancel] [Convert project]   |
+----------------------------------------------------------------+
```

"Start an intake" opens `/intake` with the project preselected and the notes listed as sources (existing intake, `projectId` prefill).

---

## 9. Knock-on effects

| Area | Change |
| --- | --- |
| Phases (`packages/shared/src/phases`, `commands/phases.ts`) | Members: any card of the project with origin `manual`/`intake` regardless of workflow, so research cards may join. `phaseCompletion` gains the resolution `published` (done via `ResearchPublished`), which counts as resolved. Deploy and regression follow-ups are refused when the project has no repos or no test stage (400 `followup_needs_repos`), shown greyed in `FollowupEditor`. Phases cannot be created on interest backing projects (409 `managed_by_interest`). Conversion during an open phase is allowed |
| BA reporter (`reporter/digest.ts`, `detectors.ts`, `mock-agent.ts` floor sections) | The six sections stay. "Failures" gains `interest_failing` (a new detector: `interests.fail_count >= 3`, or the last 3 runs `failed`; fingerprint `interest:<id>`). "Stuck" excludes interest run cards waiting inside the preferred-agent grace. The fallback project for reporter tasks skips `kind='interest'`. `floor_report` gets one line "Interests: N runs, M items published, K unrated" (counts only; Q13). Interest rating desk items stay `ROUTING_EXEMPT` |
| Repo hygiene | `hygieneSpecFor` adds `p.kind = 'project'` (defensive; backing projects have no repos). Branch-confirm reacts to `ProjectConverted`. Research-stage projects cannot get repos (§8.2) |
| Archive and delete | Projects: archive unchanged. Delete no longer retires agents (D9). `deleteProjectRows` no longer touches `interests`/`taste_seeds` for visible projects; for backing projects, delete goes through the interest. Interests: archive and restore (soft), permanent delete after archive |
| Interests page | Rewritten (§7.2). `AdoptSchedulesDialog`, the project selects and the "project taste rules" panel are removed |
| Nav | §7.3 |
| Intake | Mapping candidates exclude backing projects. A Research-first project can be the intake's target; the BA drafts research cards there |
| Org designer | Workflow selection for new projects hides `feed`. Built-in `feed` stays registered (cards use it) |
| Metrics, HR stats | Exclude backing projects from per-project charts; agents' stats are per agent (no change). `hired_for_project_id` is shown as history |
| Docs | `SPEC.md` "Projects, types and scheduling", "Expanding the organization", "Users ... Agents", "Research and feeds"; `ARCHITECTURE.md` §4, §5.2, §9.2-9.3, §10, §16.1, §17.2, §19, §21; `USER-GUIDE.md` |

---

## 10. Mock runtime and e2e

### Mock (`apps/runner/src/adapters/mock-agent.ts`)

- Feed and research cards are unchanged in shape. The mock researcher logs `mock seed sources: N` when `fields.seedSources` is present.
- New BA task kind `scheduled_brief`: it reports `aom report notice --text "<prompt summary>"`. Server fallback: a desk notice with the prompt.
- Runner command `integration.run` (`apps/runner/src/integrations/poll.ts`): with `AOM_MOCK_SOURCES_DIR` it reads the fixture tickets (the same files intake uses). The real version uses `gh issue list --search` or Jira REST with the existing runner config.
- No change for agents or conversion. The vault fixture (`e2e/support/vault.ts`) checks `interests/<slug>/` paths.

### E2E (Playwright, mock runtime)

| Spec | Plan |
| --- | --- |
| `feeds.spec.ts` | **Deleted.** Its acceptance cases move into `interests.spec.ts`: on-time fire ahead of normal work, best N across kinds, taste.md from verdicts, curator rule proposal, dedup and the untouched list, nothing qualified, no fabrication |
| `interests.spec.ts` | **Rewritten**: setup (runner, personal vault, scout, curator, researcher, checker); create an interest (folder `interests/<slug>/` gets `INTEREST.md`); taste rules → managed section, edit replaces, Resync; Run scan → run log shows found → published, items, transcript status, shift logs; rate → counts and `taste.md` rating line in the interest folder; after-scan research → child run, note in `notes/`; preferred agent: with two scouts, the assigned one claims; pause tick stops the cadence (test clock), resume sets the next run; archive and restore; mobile 390x844 |
| `interests-migration.spec.ts` (new) | Seeds the legacy state through the API **before** the data migration: start the server with `AOM_DATA_MIGRATIONS=off`, create a feed project with a linked interest, an unlinked feed schedule, ratings and a transcript. Restart with migrations on. Assert: no feed project in the list; two interests; run log shows the migrated runs with ratings; `/p/KEY/feed` redirects; the old `taste.md` is untouched; the second interest's `taste.md` has the `imported` section |
| `research.spec.ts` | Setup uses "Research first". Add: a research card in a code project (board shows the extra columns); conversion: add the toy repo, keep the open research card, the branch-confirm question appears, `PROJECT.md` gets `research-index`, and the kept card publishes after conversion |
| `sharing.spec.ts` | AC6c: the guest hires into the owner's org (no project scope). AC6d unchanged. New: the guest's agent does **not** claim a card of the owner's unshared project. AC7a: removal with a second shared project keeps the agent active |
| `hr.spec.ts` | Focus: two projects of different tiers; a focused agent takes the lower-tier project's card first |
| `schedules.spec.ts` (new) | Create-card schedule with a `{date}` title (run now); DevOps request action (the mock DevOps completes); BA task action (notice on the desk); integration poll (fixture tickets → intake) |
| `phases.spec.ts`, `reporter.spec.ts`, `hygiene.spec.ts` | Run unchanged; fix only selectors touched by the nav change |
| `guide-screenshots.spec.ts` | Update the Interests shots; drop the feed page |

Server tests (vitest, `aom_test`):
- `restructure-migration.test.ts`: fixtures for every case in §5.4, idempotency (run twice), and rebuild equality after the migration;
- `org-agents.test.ts`: eligibility matrix of §4.6, focus and skills ordering, member removal;
- `interest-runs.test.ts`: every row of §3.4's run table, after-scan, backoff, `run_in_progress`;
- `schedules-actions.test.ts`;
- `project-convert.test.ts`;
- `visible-projects.test.ts`: every list endpoint hides backing projects;
- update `isolation.test.ts`.

---

## 11. Risks

- **R1 Hidden projects leak into lists.** Any query that forgets `kind='project'` shows a backing project. Mitigations: the single helper, the `visible-projects` test over every list route, and the board, settings and phase routes refusing backing projects.
- **R2 Wider reach of guest agents.** A guest's agent now works every project the guest shares in that org, not just the one it was hired for. This is intended (D7), but a guest's machine receives repos of a second shared project. That is the consequence of membership, and the HR card shows "N shared projects".
- **R3 Data migration correctness.** The migration is one-way. Mitigations: idempotent steps, a per-org transaction, the report on the desk, a pre-migration database backup note in `DEPLOY.md`, and the e2e migration spec. Nothing is deleted except feed schedule rows (events keep them).
- **R4 Replay compatibility.** v1 interest events, `ScheduleCreated` without `action`, and `AgentHired{projectId}` must still project correctly. A rebuild-equality test after the migration covers this.
- **R5 Live updates for guests** on org-scoped agent events, and on backing projects they are not members of. Polling is the mitigation. A later fix is an `org_members` audience.
- **R6 Preferred-agent grace** delays a run by up to 10 minutes when the preferred agent is online but busy. This is accepted (fires on time; claim may wait).
- **R7 Parallel work.** The builder is editing `apps/` now. Migration numbers, `interests.ts` and the Interests page will conflict, so rebase step by step.
- **R8 Vault folder split.** Migrated first interests live in `projects/<folder>/`, new ones in `interests/<slug>/`. This is cosmetic, and Q6 covers it.
- **R9 Dispatcher cost.** The new `EXISTS project_members` per candidate is indexed (`project_members` PK). Measure on the e2e dataset and add `(user_id, project_id) WHERE status='active'` if needed.

---

## 12. Open questions (each with a recommended default)

1. **Q1 Is a hidden backing project per interest acceptable as the implementation of "feed projects are removed"?** Default: yes. Users never see it, and it keeps every feed mechanism unchanged.
2. **Q2 Who may see and edit an interest?** Default: any active member of its backing project. That is the creator and the org owner, plus members copied from a shared feed project or added by sharing. "Any member" edits interests and taste.
3. **Q3 May a guest create interests in the owner's org?** Default: only `work`-domain ones, shared with the owner. Personal-domain interests stay in the creator's own org.
4. **Q4 Preferred-agent grace period?** Default: 10 minutes, then any qualified agent.
5. **Q5 May the domain (work or personal vault) change after the first run?** Default: no, because history and the vault folder would split. Create a new interest instead.
6. **Q6 Move migrated vault folders to `interests/<slug>/`?** Default: not now. Later, add a "Move folder" action through a new runner `vault.move` command.
7. **Q7 Create a brand-new repository during conversion?** Default: not in v1. Add an existing repo URL, or create the repo first through the existing repo request.
8. **Q8 Fold repo hygiene and the daily floor report into Schedules?** Default: no. Show them as read-only "System" rows linking to their settings.
9. **Q9 Event triggers for schedules (e.g. "when a phase completes")?** Default: no. Cron and manual only.
10. **Q10 Lend agents across orgs (a guest's own agents working the owner's project)?** Default: no. The guest hires into the owner's org.
11. **Q11 Per-project WIP limit (max concurrent shifts per project)?** Default: none. Focus and tiers are enough.
12. **Q12 Allow converting code to custom, or back to research?** Default: only research to code or custom. Other changes stay on the workflow field for non-research projects, owner only.
13. **Q13 Interests in the daily floor report?** Default: one count line, plus failing interests under Failures.
14. **Q14 Research option cadence default?** Default: off. When it is turned on, "after each scan" with depth Standard.
15. **Q15 Should a converted research project keep "Research first" as a visible label?** Default: a small "Started as research" note on settings only.
16. **Q16 Integration actions in v1?** Default: `issues_poll` for GitHub and Jira only, which feeds intake. Outbound integrations stay approval-gated as today.

---

## 13. Implementation plan (ordered; each step ends green: `pnpm typecheck && pnpm lint && pnpm test`, and e2e where noted)

### Part A: org-level agents (independent, smallest first)

1. **Shared contracts.**
   - `events/agent.ts`: `AgentHired.focusProjectIds?`, new `AgentFocusSet`.
   - `events/project.ts`: `ProjectSkillsSet`.
   - `api/agents.ts`: `HireAgentRequest {orgId?, focusProjectIds?, projectId? (alias)}`, `AgentDto {hiredForProjectId, focusProjectIds, eligibleProjects}`.
   - `authz/index.ts`: `canHireAgent` with `isOrgMember`, `canDirectAgent` with a shared-project check.
   - Tests in `packages/shared/test`.
2. **Migration `1310_org_agents.sql`** and projectors (`projections/agents.ts`: `hired_for_project_id`, focus; `projections/projects.ts`: skills). Rebuild test.
3. **Eligibility.** In `dispatcher/candidates.ts` change `scope` to the membership clause, drop `projectId` from `AgentView`/`AgentRefs`, and add the focus and skills ordering (`$10`, `$11`). Update `dispatcher.ts` params and `queries/workability.ts`. New `apps/server/test/org-agents.test.ts`.
4. **Other readers.** `dispatcher/ba-tasks.ts`, `dispatcher/bottleneck.ts`, `queries/agents.ts`, `commands/agents.ts` (`hireAgent`, `manageableAgent`, focus route), `hr/hr.ts`, `reporter/routing.ts`/`reporter.ts`, `routes/agents.ts`, `routes/projects.ts` (skills).
5. **Delete and removal.** `commands/projects.ts deleteProject` stops retiring agents. `projections/projects.ts` removes the deleted project from focus. `projections/sharing.ts` + `commands/sharing.ts` apply the member-removal rule (§4.4). Extend `projects-delete` and sharing tests.
6. **Web HR.** `pages/Agents.tsx` HireDialog (org select, focus multi-select), the agent card ("Works on", focus chips), `ProjectSettings` preferred skills. `apps/web/test` updates.
7. **E2E.** `sharing.spec.ts` and `hr.spec.ts` changes (§10).

### Part B: generic schedules

8. **Shared.** `ScheduleAction` union, `events/schedule.ts` changes (nullable `projectId`, `action`, `ScheduleFired.result`), `api/schedules.ts` DTO `{trigger, action}`, `expandTitle({date},{week})`, `legacyAction(kind, projectId, template)`. Tests.
9. **Migration `1311_schedule_actions.sql`** and `projections/schedules.ts` (`action` from event or legacy).
10. **Firing by action.** In `commands/schedules.ts`: `scheduleActionEvents` (`create_card` and `regression_run` move here from `fireDueSchedules`); create and patch validation per action plus the authorization in D12; refuse `feed`; `run` for every action. Tests: `schedules-actions.test.ts`.
11. **DevOps and BA actions.**
    - `devops_request` through `createDevOpsRequestIn`; `hygiene: true` through `requestHygiene`.
    - `ba_task`: add `scheduled_brief` to `BaTaskKind` (shared and the `ba_tasks.kind` CHECK in the same migration file as step 9), `applyReporterReport`/`aom report notice`, the server fallback, and the mock.
12. **Integration action.**
    - Runner command `integration.run` (`apps/runner/src/integrations/poll.ts`, mock fixtures).
    - Server `command.result` → intake creation with the tickets (reuse `commands/intake.ts`).
    - Runner and server tests.
13. **Web Schedules page.** The `pages/Schedules.tsx` wizard, grouped list, and system rows. Remove the feed hint and the interest lock UI. New `e2e/tests/schedules.spec.ts`.

### Part C: research stage and conversion

14. **Card workflow by type.** `resolveCardWorkflow` in `commands/cards.ts` (used by create, schedules and intake drafts); `CardNew` type list; `cards/columns.ts` extra columns; `BoardView`. Tests for creating a research card in a code project and for the board columns.
15. **Migration `1312_project_stage.sql`**, the `ProjectConverted` event and projector, and `WorkingBranchReason 'conversion'`.
16. **Convert command and route.** `commands/projects.ts convertProject`; `addRepo` guard for the research stage; branch-confirm reaction; `PROJECT.md` `research-index` section write (`renderResearchIndex` in shared); `createProject` refuses `feed`. Test: `project-convert.test.ts`.
17. **Phases knock-on.** Membership regardless of workflow, the `published` resolution in `phaseCompletion`, and the follow-up guard. Extend the phases tests.
18. **Web.** The new-project form ("Research first"), the badge, the settings Stage panel, the `ConvertProjectDialog`, the board header button, and the intake prefill.
19. **E2E.** `research.spec.ts` additions.

### Part D: org-level interests

20. **Shared.**
    - `interests/index.ts` v2 (`InterestBody` v2 with legacy optionals, `ResearchSpec`, `interestSlug`, `interestBackingKey`, `researchRunFields`, `nextScanAt`, `PREFERRED_AGENT_GRACE_MS`).
    - `events/interest.ts` (`InterestArchived/Restored`, `InterestTasteSet`, `InterestRunStarted`, `InterestRunFailed`, `InterestMigrated`).
    - `events/project.ts` (`kind`, `vaultDir`, `members` on `ProjectCreated`; `ProjectKindChanged`).
    - `events/card.ts` (`interestRunId`, `preferredAgents`).
    - `vaults/index.ts` `projectVaultFolder` with `vaultDir`.
    - `api/interests.ts` v2 and run DTOs.
    - Tests.
21. **Migration `1313_interests_org.sql`** and projections: `projections/projects.ts` (kind, vault_dir, members), `projections/interests.ts` v2 (+ legacy mapping), new `projections/interest-runs.ts`, `projections/cards.ts`. Add to `PROJECTION_TABLES`. Rebuild test.
22. **Visible projects.** Add the `VISIBLE_PROJECT_KIND` helper and apply it to every list and lookup listed in §7.1. Backing projects are refused on project routes (409 `managed_by_interest`). Test: `visible-projects.test.ts`.
23. **Interest commands.** Rewrite `commands/interests.ts` (create with the backing project, update, archive, restore, delete, taste, resync, run) and `queries/interests.ts` (list, detail, runs, run detail, digest, eligible agents). Rewrite `routes/interests.ts`, removing adopt and the taste-seed routes. Tests: `interests.test.ts` rewritten.
24. **Cadence.** `fireDueInterests` in the scheduler tick (`scheduler/scheduler.ts`), backoff, the `interest_failing` notice, `run_in_progress`. Remove interest coupling from `commands/schedules.ts` (`syncSchedule`, the 409 lock). Tests with the test clock.
25. **Preferred agents.** The `preferred` eligibility clause, `$9 now` in workability, and the overflow pass preferring them. Tests.
26. **After-scan research and the run projector.** `commands/feeds.ts buildDigestEvents` and the research card `seedSources` (fields schema). Tests: `interest-runs.test.ts`.
27. **Taste and vault.**
    - `commands/taste.ts`: `InterestTasteSet` section, rating routing by interest, `INTEREST.md` section on create and update, `runs.md` append on a finished run.
    - `brief.ts` `tasteSeed` from the interest.
    - `stripManagedSection` `keep` option.
    - Runner `transcript/service.ts` and `research/publish.ts` take the folder from the brief.
    - Runner and server tests.
28. **Data migration.** `apps/server/src/data-migrations/{index,restructure}.ts`, boot hook in `main.ts` (before dispatcher and scheduler), env `AOM_DATA_MIGRATIONS` (default on), per-org report and desk alert. Test: `restructure-migration.test.ts` (all cases of §5.4, idempotent, rebuild equality).
29. **Reporter knock-on.** The `interest_failing` detector, the floor digest count line, fallback project selection, and stuck-card grace. Extend the reporter tests and mock floor sections.
30. **Web Interests v2.**
    - `pages/Interests.tsx` list with the active tick, and the detail with tabs (`components/interests/InterestDetail.tsx`, `RunLog.tsx`, `RunRow.tsx`, `InterestSettingsForm.tsx`, `TasteTab.tsx`, `DigestTab.tsx`).
    - Remove `AdoptSchedulesDialog`, the project selects and `FeedProject.tsx`; add the redirects; update the nav config.
    - Queries in `api/queries/interests.ts`, `ws/invalidate.ts`, MSW handlers.
    - Web tests.
31. **E2E.** Rewrite `interests.spec.ts`, delete `feeds.spec.ts`, add `interests-migration.spec.ts`, update `guide-screenshots.spec.ts`. Full suite green.
32. **Cleanup.** Drop `taste_seeds` from `PROJECTION_TABLES` (keep the table, `TasteSeedSet` projector a no-op). Remove `ScheduleLinked` writers (keep the event for replay).
33. **Docs.** `SPEC.md`, `ARCHITECTURE.md`, `USER-GUIDE.md`, `DEPLOY.md` (backup before upgrade); mark `interests.md` as superseded in part, and this document as built.

---
## Owner decisions (2026-10-06 evening). These override the defaults above.

### New requirements
- **Agents: org-wide but assignable.** Agents belong to the org, and the manager **assigns them to projects and controls where each one may and may not work**. Use a per-agent allow-list of projects; the default for a new hire is decided at hire time, with an "any project" option. The dispatcher only offers a card to an agent allowed on that project, combined with the workstation-membership rule (D-agents). Focus projects stay as a soft preference inside the allow-list.
- **Interest run and delivery schedule, so the manager is not flooded.** Each interest has:
  - a **run schedule**: when scans happen (cron or simple presets, timezone-aware);
  - a **delivery schedule**: when results reach the manager. New items are batched into a digest delivered at chosen times (for example weekdays 07:00), and nothing is pushed between deliveries.
  - an org-level **quiet cap** on how many digest items may arrive per day across all interests.

  Runs can happen ahead of delivery; delivery is what lands on the desk and in the floor report.
- **Roadmap after the restructure:**
  - (1) **Per-project budgets and cost tracking:** token and cost use recorded per shift, rolled up per agent, card, project and phase. A monthly budget per project, a warning at 80% to the BA and the desk, and an automatic pause of the project's dispatching at 100% until the manager raises the budget or overrides. Spend is shown on the project, the HR board and the floor report.
  - (2) **A visual org chart page:** roles, seniority, reporting and escalation lines, and agents with their faces.

### Answers to the 16 open questions
| # | Decision |
|---|---|
| 1 | Hidden backing project per interest: **yes**. |
| 2 | Any active member of the interest's project sees and edits it. |
| 3 | **Guests may create any interest**, private to them unless shared. |
| 4 | **No preference window:** any qualified, allowed agent takes an interest run immediately (the assigned agent is a soft preference only). |
| 5 | An interest's vault domain is fixed after its first run. |
| 6 | **Move the existing feed folders to `interests/<slug>/` during the migration.** Add a runner `vault.move` (git mv, commit, push) used by the migration, idempotent and safe if it is interrupted. |
| 7 | **Create a new GitHub repo from the convert dialog**, still via the owner's approval (reuse the `aom repo create` flow). |
| 8 | Repo check and floor report are shown as read-only system rows on Schedules. |
| 9 | **Add event triggers** to schedules: internal events such as phase completed, card finalized, interest run done, project converted, plus GitHub/Jira labelled-issue events via polling. |
| 10 | No lending of a guest's agents. |
| 11 | **Optional per-project concurrency cap**, off by default (fits per-project budgets). |
| 12 | **Any → any project conversions** (research, code and custom workflows), with the same keep/cancel handling for open cards that the new workflow can't place. |
| 13 | **The floor report gets an Interests highlights section** (top items per interest since the last report), respecting the delivery schedule and quiet cap. |
| 14 | Interest research is **off, on demand only** ("Research this" on an interest or an item). |
| 15 | A converted project gets a **Research tab** keeping its research notes front and centre. |
| 16 | V1 integrations: **GitHub/Jira issue polling into intake, outgoing webhooks** (POST JSON to a URL; Slack, Teams, n8n and Zapier compatible; signed), and **email digests** at a set time. |

---

## Impact of organizations (`docs/design/organizations.md`, 2026-10-06)

Organizations, org roles (Owner > Admin > Member, plus Guests) and licensing are built **before** this restructure (organizations.md §17). Everywhere above, "the org owner" means **the org's Owner or an Admin**, "org member" means an active `org_members` row, and "guest" means a user with access to a shared project of an org they are not a member of. `userId === orgId` no longer exists. Take migration numbers after the organizations ones, and add `restructure-2026-10` to the `data-migrations/index.ts` that organizations creates, after `orgs-2026-10`.

Owner decisions that override this document:

- **Only the Owner and Admins create projects and add people** (org members and guests). This affects conversion (§8.2: Owner/Admin) and interest sharing (§5.1 "Share an interest": Owner/Admin of the interest's org).
- **Interests use the role hierarchy** (replaces D12 and §5.1 "any active member may edit"): you may edit, delete, pause, archive, run or change the taste rules of an interest only if its creator's rank is at or below yours (Owner > Admin > Member > Guest), or you created it. Viewing is unchanged (members of the backing project). `interests.created_by_rank` is stored at creation; the creator's **current** rank in the org counts, the stored rank is the fallback when the creator has left (organizations.md §4.3).
- **Schedules:** project-bound actions may be created and edited by any active member of that project, including Guests on shared projects. Org-level actions (BA tasks not bound to a project, hygiene, integrations not bound to a project) are Owner/Admin only. Workstation-targeted actions (DevOps, integration polling on a runner) additionally need the workstation's user (replaces D12's schedule clause).

Steps that change:

| Step | Change |
| --- | --- |
| 1 | `canHireAgent({actor, orgId})`: Owner/Admin with any allow-list; Members and Guests onto their own workstation with an allow-list inside the projects they are on. `canManageAgent`: Owner/Admin or the hiring manager. `canDirectAgent`: Owner/Admin, or a project member for agents allowed on that project. All take the `Actor` of organizations.md §4.1 |
| 2 | `1310_org_agents.sql` becomes the next number after the organizations migrations; its FKs reference `organizations` |
| 3 | Eligibility: the agent's manager must still be an active org member or an active guest of the card's project; agents of suspended orgs are never candidates (organizations.md §7.6) |
| 4 | "Other readers": replace the remaining `userId === orgId` checks with org roles |
| 5 | §4.4 `ProjectMemberRemoved`: "no other active membership in the org" means another active project of that org for a guest; an org Member keeps their agents until `OrgMemberRemoved` (organizations.md §8.3) |
| 6 | Hire dialog: org select lists orgs where the user is a member or a guest; the allow-list picker is limited by role; hire is refused at `max_agents` / `max_workstations` (409 `limit_reached`) |
| 10 | Schedule create/patch authorization per the decision above; scheduled fires of suspended orgs are skipped |
| 16 | `convertProject`: Owner/Admin only; `max_projects` re-checked when a research project becomes a counted project |
| 20, 21 | `InterestCreated` gains `creatorRank`; `interests.created_by_rank`. Backing projects are excluded from `max_projects` |
| 22 | `VISIBLE_PROJECT_KIND` composes with the `project_members` org grants; no other visibility change |
| 23 | Interest commands use `canEditInterest` (rank rule); `POST /api/interests/:id/members` is Owner/Admin |
| 24 | `fireDueInterests` skips suspended orgs and orgs with the `interests` feature off |
| 28 | `restructure-2026-10` runs per organization (ids are unchanged); its desk report is an org-level item visible to Owner/Admins |
| 30 | Interests page: edit controls follow `canEditInterest`; schedule controls follow the schedule rule; feature flag hides the page |
| Roadmap | Per-project budgets: set and overridden by Owner/Admin. Org quiet cap: Owner/Admin. Org chart: visible to org members |


---

## Implementation status

### Part A: agents belong to the org (built, 7 Oct 2026)

Built to the owner decisions and the organizations overrides above. Where the build differs from the plan in section 13:

- **Migration** is `1313_agent_allow_list.sql` (not `1310_org_agents.sql`: 1310 to 1312 are the organization migrations). It renames `agents.project_id` to `hired_for_project_id` (history only, no foreign key), adds `allowed_project_ids uuid[]` (NULL = any project) and `focus_project_ids uuid[] NOT NULL DEFAULT '{}'`, and `projects.max_concurrent_shifts integer NULL`. Existing agents get `[hired_for_project_id]` when they were project-scoped and NULL (any) otherwise. The backfill runs only in the step that adds the column, so running the file again never overwrites an allow-list a manager set later. Covered by `migrate.test.ts`.
- **Allow-list, not a focus default.** The owner's per-agent allow-list replaced the design's "work any project the workstation owner is on": `AgentHired` carries `allowedProjectIds` (list or null) and `focusProjectIds`; `AgentAllowedSet` and `AgentFocusSet` change them. An `AgentHired` written before this (only `projectId`) replays as `[projectId]`, or "any" without a project, so a rebuild equals the migrated data (`org-agents.test.ts`). `projectId` stays accepted on the hire request as an alias (allowed `[projectId]`, hired-for `projectId`).
- **Eligibility** (`dispatcher/candidates.ts eligibility().scope`, shared with `queries/workability.ts`): the card's org, then the agent's allow-list, then an active `project_members` row of the agent's workstation owner on the card's project. The Owner and Admins hold such a row in every project of their org (organizations.md), a guest only in shared projects, so "member or Owner/Admin of the project's org with access to the project" is one check. Suspended organizations are still excluded by the candidate join. The same rule is applied by the BA-task pass, the tester-bottleneck check, question escalation and the reporter's BA lookup.
- **Focus ordering**: the agent's focus projects sort before the project tier (`$10`). **Dropped from this build** (not asked for in the owner decisions): `projects.preferred_skills` / `ProjectSkillsSet` and the skills-overlap ordering term (step 6 of the old plan).
- **Concurrency cap** (decision 11): `projects.max_concurrent_shifts`, event `ProjectConcurrencyCapSet`, `PUT /api/projects/:id/concurrency-cap {cap: 1..50 | null}`, any project member. It is a hard cap in the candidate query, so it also binds the late-scheduled overflow path. A card waiting because of the cap shows no special reason on the board (it is just queued).
- **Who may set what**: `PUT /api/agents/:id/allowed-projects` and `/focus-projects` need the right to change the agent (Owner/Admin or the hiring manager). Members and guests may only name projects they are on and never "any project". The focus must lie inside the allow-list (400 `focus_not_allowed`); narrowing the allow-list drops projects from the focus. The DevOps engineer is refused (400 `devops_fixed`): allow-lists do not apply to it.
- **Hiring**: a guest hires into the org that owns the first allowed project (the request org otherwise). Agent events are org events (`orgScope`); live updates for guests rely on polling (R5).
- **Visibility**: a user sees the agents of their active org (as a member) plus, in any org, the non-DevOps agents allowed on a project that both they and the agent's workstation owner are on. This means a guest also sees the owner's "any project" agents when the owner is on the shared project, which is what section 4.4 specifies; the old behaviour hid them. The tests were updated.
- **Project delete** keeps the agents: the project leaves every allow-list and focus and `hired_for_project_id` keeps the id. **Changed 7 Oct 2026 (owner decision):** an agent that was allowed on that project only is **benched** (an empty allow-list) instead of becoming "any", and `deleteProject` raises one org-level desk notice (`alert/agents_benched`) listing the benched agents so the manager can reassign them.
- **Member removal** (`commands/sharing.ts removalPlan`, `projections/sharing.ts`): claims on the project are released for the member's agents; the agents are re-homed (`needs_rehome`) only when it was the member's last access in the org (no other active project, no org grant). An org Member keeps their agents until `OrgMemberRemoved`. The project leaves the focus of the member's agents.
- **Web**: `components/agents/ProjectAccess.tsx` (the allow-list and focus editor, the "Works on" chips, the **Projects** dialog on each agent card), the Hire form replaces its Project select with the editor (default: the project worked on last; "Any project" for Owners and Admins), and `components/ConcurrencyCapPanel.tsx` in project settings. There is no separate agent detail page: the agent card is the detail.
- **Tests**: `apps/server/test/org-agents.test.ts` (eligibility matrix of allow-list, membership and guest workstation; focus ordering; cap; permissions; member removal; rebuild with legacy events), `migrate.test.ts` (1313), `packages/shared/test/agent-allow-list.test.ts`, `apps/web/src/test/agent-projects.test.tsx` and the Hire form tests in `sandbox.test.tsx`, and the e2e spec `agent-projects.spec.ts`.
- **Not built (still open for the later parts)**: the organization selector in the Hire dialog (a guest picks the shared project instead), the reason text "waiting: project at its limit" in workability, and the DTO `eligibleProjects` count.

### Part B: schedules become generic cron jobs (built, 7 Oct 2026)

Built to the owner decisions (8: system rows, 9: event triggers, 16: integrations) and the organizations overrides. Where the build differs from the plan in section 13:

- **Migration** is `1314_generic_schedules.sql` (not `1311_schedule_actions.sql`, a number the organizations used). It makes `schedules.project_id`, `cron`, `timezone` and `card_template` nullable, adds `trigger`, `action`, `owner_user_id`, `last_status`, `last_summary`, replaces the kind check, backfills `trigger`/`action` of rows that have none (only those, so a second run never overwrites), and creates `schedule_runs`, `schedule_attempts`, `schedule_issues` and the operational `schedule_trigger_cursor`. It also adds `scheduled_brief` to `ba_tasks.kind` with `instructions`, `deliver`, `schedule_id`, `schedule_name` and `org_level`. All of it is idempotent (`IF NOT EXISTS`, `DROP ... IF EXISTS`). The projector derives `trigger` and `action` for events written earlier, so a rebuild equals the migrated data (`schedules-generic.test.ts`, "a rebuild reproduces ...").
- **Triggers**: cron (presets, zone), manual, `event` (`phase_completed`, `card_finalized`, `interest_run_done`, `project_converted`, optionally per project or interest) and `issue_labelled` (GitHub or Jira polled by the owner's runner on a cron cadence). **Event triggers are evaluated by a cursor sweep of the event log** (not a hook on the append path), kicked by the notifier and by the 15 s tick; the reasons and the dedupe key are in ARCHITECTURE section 10.3. `interest_run_done` maps to `DigestPosted` of a card that belongs to an interest until Part D has its own run-done event (the mapping is one table in `schedule-triggers.ts`); `project_converted` matches `ProjectConverted`, which Part C appends.
- **Actions**: `create_card` (template, `{date}`, `{week}`, `{event}`, `{ref}`, `{project}`, `{issue...}`), `regression_run`, `devops_request` (free text, or hygiene), `ba_task` (new BA task kind `scheduled_brief`; the report lands as a desk item, with the BA chat linked on request), and `integration`: GitHub/Jira `issues_poll` into intake (runner command `integration.run`), outgoing `webhook` (HMAC-SHA256 signed, per-webhook secret encrypted with `AOM_SECRET_KEY`, retries 1 min / 5 min / 30 min / 2 h, five tries, a delivery log, formats generic, Slack and Teams, an SSRF guard, a test button) and an `email` digest (floor report, project summary; the `interests` digest is a registered hook, `registerDigest`, refused until Part D registers it).
- **Not built as written in the plan**: the `specify` flag of `create_card` (cards are created queued, as scheduled cards always were); feed schedules keep the `feed` kind and their own "Run now" path until Part D migrates them into interests (creating one is a 400 `use_interests`; existing ones stay editable and listed; interest-managed ones still show "Managed by interest", which Part D removes with the interest lock).
- **Authorization** (`commands/schedules.ts authorize`): a project-bound action may be created, changed, run and deleted by any active member of the project, guests included. Organization-level actions (BA task without a project, hygiene, a webhook or an integration without a project, the floor report digest) need the Owner or an Admin of the organization (`X-AOM-Org`, else the project's). Workstation actions need the workstation's user. A Member or guest may e-mail themselves only. Before, all schedules were limited to the project owner. The schedule runs as its creator and stops (with a desk notice) when the creator loses access.
- **System rows** (`GET /api/schedules` `system[]`): repository hygiene per workstation of the viewer and the BA floor report per organization of which the viewer is Owner or Admin; read-only, with a link to where each is configured.
- **Web**: `pages/Schedules.tsx` (groups, status, run now, pause, edit, delete, history, system rows), `components/schedules/ScheduleWizard.tsx` (when, what, details; org-level warning for non-managers), `components/schedules/RunHistory.tsx` (runs and the delivery log with every try), test button, secret shown once. Tests: `schedules.test.tsx` (web), `schedules-generic.test.ts` (server: actions, permissions, event triggers, webhooks with a local HTTP server, e-mail, issue polling with a fake runner, rebuild), `schedules.test.ts` (shared), `e2e/tests/schedules.spec.ts`.
- **Mock runtime**: the mock BA answers `scheduled_brief` (`aom report brief`); the runner's issue poll reads `<data dir>/mock-issues.json` in the mock runtime, so no spec reaches GitHub or Jira.
- **Also in this build**: `hr-authz.test.ts` (emptied by Part A, which made `pnpm test` fail on "no test suite") is removed; the Part A project-delete rule changed to benching (see Part A above).
- **Tests**: shared 402, web 286, runner 398, server 756+ (102 files), e2e 162 (the new `schedules.spec.ts` has 8: cron wizard, event trigger with a signed Slack webhook, test button and retry, e-mail digest through Mailpit, issue polling into intake with the mock fixture, BA task, guest permissions). The e2e stack sets `AOM_LEGACY_FEED_SCHEDULES` so the old feed specs can still create the feed schedules an old installation holds; their Schedules page test (AC6) now goes through the wizard.
- **Open for Part D**: the interests digest hook, `interest_run_done` on the real run event, removal of feed schedules and the interest lock.

### Part C: research is a stage, projects convert (built, 7 Oct 2026)

Built to the owner decisions (7: a new repository from the convert dialog, 12: any to any, 15: a Research tab) and the organization overrides (Owner and Admins convert). Where the build differs from the plan in section 13:

- **Migration** is `1315_project_stage.sql` (not `1312_project_stage.sql`: 1312 belongs to two-factor login). It adds `projects.started_as`, `converted_at`, `converted_by` and `pending_conversion`, and makes `repo_requests.requested_by_agent_id` nullable with `requested_by_user_id` (a request from the manager's dialog). `started_as` is read from each project's own `ProjectCreated` event, so a workflow changed by the old settings form does not rewrite what it started as; the other projects fall back to their workflow. Idempotent (`IF NOT EXISTS`, backfill only rows without a value); the projector sets `started_as` from `ProjectCreated`, so a rebuild reproduces it (`project-convert.test.ts`, `migrate.test.ts`). Existing research projects are research-stage projects (`workflow_key = 'research'`).
- **Events.** `ProjectConverted {fromWorkflowKey, toWorkflowKey, cardDecisions, cancelledCardIds, repoIds, note?, by}`, plus `ProjectConversionRequested` and `ProjectConversionCancelled` for a conversion that waits for a new repository; `CardCancelled.cause` gains `project_converted`; `RepoCreateRequested` may come from a user (`requestedByUserId`); `WorkingBranchReason` gains `conversion`. The Part B trigger `project_converted` now fires (its test, `schedules-generic.test.ts`, converts a project and checks the one run).
- **Convert (`commands/convert.ts`).** `POST /api/projects/:id/convert` and `GET .../convert-preview`, Owner and Admins only. Any workflow of the organization is a target except `feed` and `code-bugfix`. The cards the target cannot place (open cards of another workflow) are kept or cancelled with the reason "Project converted", per card or by default. A repository is needed when the target works in repositories (400 `repo_required`); `{create}` entries use the `aom repo create` flow with the manager as the asker. **Differences from the plan:** (1) a new repository does not make the conversion always wait: when another repository is supplied or exists, the project converts at once and the new one is added when approved and created; only when nothing else supplies a repository does the conversion wait (`pending_conversion`, shown in the Stage panel, cancellable, declined requests cancel it, archiving cancels it); (2) cancelling uses the same code as cancelling a card (`cancelCardIn`: the claim is released, a waiting parent resumes, the worktree is removed, the branch is kept); (3) `PATCH workflowKey` answers 400 `use_convert` for every project (not only research ones).
- **After the commit:** the working-branch question for each repository the conversion added (`reason 'conversion'`; asked without a clone, since none exists yet) and the `PROJECT.md` write: a managed `research-index` section listing the published notes (`renderResearchIndex` in shared, versioned by the event seq so a replay is a no-op, your own text in the file is kept). Repositories added by `{create}` after the project converted get `main` from the runner and are not asked about.
- **Research cards in any project:** `resolveCardWorkflow` (create, schedules, schedule templates, intake drafts); the board adds the other workflows' columns before Done while such cards are open (`boardColumnsWith`), a card carries `workflowKey` for the "Research" chip; the New card form offers the type and asks for the question.
- **Knock-ons built:** phases (a research card is a member; `published` outcome counts as resolved and shows in the report), `followup_needs_repos` (server) and greyed follow-up buttons (web), hygiene skips research-stage projects, `aom repo create` is refused in them, archive cancels a waiting conversion. **Not changed:** the reporter (no detector reads a workflow; the interest detector and the floor-report line are Part D), `max_projects` (research projects already count as projects).
- **Web:** `ConvertProjectDialog` (workflow choice cards with "Usual next step", existing or requested repositories, the open cards with a default and per-card choice, hand-over note), `ConvertPanel` (the "Stage" settings section and the waiting-conversion callout), the "Convert to project" button on a research board header, the Research tab (`pages/ResearchTab.tsx`, sidebar entry `nav-research`), a "Research" chip on foreign cards. **Not built:** "Start an intake with the BA from these notes" in the dialog (the notes are in PROJECT.md; open an intake on the project by hand) and the "Set up on <workstation>" checkboxes (the DevOps engineer's repository scan already clones new repositories).
- **Test counts at the end of Part C:** shared 410, web 307, runner 398, server 778 (103 files), e2e 170 (the new `project-convert.spec.ts` has 8: setup, the Research tab and the repository refusal, convert with an existing repository with keep and cancel and the `PROJECT.md` write and the branch question, the kept card publishing after the conversion, a research card in a code project, a requested repository approved and created, a guest who cannot convert, the dialog on a phone).
- **Tests:** `project-convert.test.ts` (research cards in any project, stage rules, matrix research/code/custom, keep and cancel, validation, permissions, the branch question, `PROJECT.md`, repository requests: approve, decline, cancel, mixed, archive, rebuild), `migrate.test.ts` (1315), `schedules-generic.test.ts` (trigger), `cards.test.ts` (updated), shared `convert.test.ts`, web `convert.test.tsx`, e2e `project-convert.spec.ts`.
