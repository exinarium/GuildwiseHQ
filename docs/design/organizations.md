# Design: organizations, org roles, super admin and licensing

Oct 6, 2026 · status: design (not built) · companion to `docs/SPEC.md`, `docs/ARCHITECTURE.md` (referenced as §n), `docs/design/restructure.md` (built **after** this, see §17) and the Guildwise HQ design system (`docs/design/ui/*`)

Today every user *is* an organization: each `org_id` column holds a user id (`projects`, `agents`, `cards`, `desk_items`, `ledger_entries`, `vaults`, `devops_requests`, `shifts`, `threads`, `schedules`, `intakes`, `outbound`, `catalogue` overrides, `departments`, `phases`, `ba_signals`, `hygiene_findings`, `interests`, `repo_requests`, and `events.org_id`). The FK target is `users(id)` (the `agent_stats` tables have no FK). `users.role` ('admin' | 'member') is an app-wide administrator role (`auth/guards.ts requireAdmin`, `/api/admin/*`, `pages/Admin.tsx`, the `admin:create` CLI). Sharing a project (`project_members`, role `manager`) is the only way two users work together. "Org owner" is written in code as `userId === orgId` (`packages/shared/src/authz/index.ts`, `hr/hr.ts`, `commands/{designer,vaults,sharing}.ts`, `queries/desk.ts`, `browser-gateway/gateway.ts`), and about 100 SQL predicates `org_id = $n` and 16 `orgScope(user.id)` call sites pass the user id as the org.

This design makes organizations first-class, adds org roles and a platform super admin, makes the platform licensing-ready, and migrates existing data with the same UUIDs.

---

## 0. Decision summary

| # | Decision | Chosen | Rejected alternatives (one line each) |
| --- | --- | --- | --- |
| D1 | Org identity in the migration | **`org.id = old user id`** for every migrated org. No event, `org_id` column or vault path is rewritten. Only the FK target changes from `users` to `organizations` | New org UUIDs: every one of ~25 tables and the append-only `events.org_id` would need rewriting, which the trigger forbids. Re-pointing via an `org_alias` table: a permanent second id everywhere. |
| D2 | How the migration stays replayable | The boot data migration **appends** `OrganizationCreated` + `OrgMemberAdded` events. The org FKs are `DEFERRABLE INITIALLY DEFERRED`, so a rebuild (one transaction) replays legacy `ProjectCreated` before the late `OrganizationCreated` and the check passes at commit | Projector-implicit personal org on `UserBootstrapped`/`InvitationAccepted`: creates orgs for users who own nothing and hides the migration in projector code. Rewriting history: the events table is append-only. |
| D3 | Who gets an org in the migration | Every user id that appears as an `org_id` value anywhere (projects, agents incl. the auto-hired DevOps engineer, vaults, desk, ledger, catalogue, events). That is the owner's "owns projects or agents" rule, made exact. A user with no org data becomes an org-less account (guest only) | Org for every user: empty orgs clutter the platform list and count against nothing. |
| D4 | Super admin | `users.kind = 'super_admin'`: same login, sessions and password code, **no org membership possible**, platform routes only, created only by the CLI | A separate `platform_admins` table and login: duplicates auth. A flag on an org member: breaks "belongs to no organization". |
| D5 | Multi-org | **Supported.** A user may be a member of several orgs (and a guest in others). The active org travels **per request** in the `X-AOM-Org` header (per tab), with `auth_sessions.active_org_id` as the remembered default | Active org only in the session row: two tabs on two orgs silently write into the wrong org. URL prefix `/o/:org/...`: rewrites every route and deep link. Single-org users: the legacy migration already produces users who are owner of one org and guest in another. |
| D6 | Project visibility for org roles | Keep `project_members` as the single visibility table. Org Owner/Admins get **projector-maintained** rows (`org_grant = true`, role `owner`); Members and Guests get direct rows (role `manager`). Every existing query that joins `project_members` stays correct | Rewriting ~40 visibility joins to `project_members OR org admin`: large, easy to miss one, and a security risk. |
| D7 | Who is a project's "owner" | **The org's Owner and Admins** (owner decision: only they create projects and add people). `project_members.role = 'owner'` now means "org Owner/Admin of the project's org". The creator is recorded (`projects.created_by`) but gets no extra rights | Keep a single creator-owner per project: contradicts "only Admins and the Owner add people" when an Admin leaves. |
| D8 | Guests | A guest is a user with an active `project_members` row in a project whose org they are **not** an active member of. Derived, not stored | A `guest` role in `org_members`: a guest would then see org-level data. |
| D9 | Org-audience events for Members | Owner/Admins receive full `org` events. Members receive them **payload-stripped** (type, stream, seq, actor only) so live invalidation works without leaking org-level desk, ledger, vault or reporter content. New `user` audience for per-user events (workstations, addressed desk items) | Full payloads to Members: leaks org-level desk items and standing orders. Nothing to Members: their agent and catalogue views go stale. |
| D10 | Licensing storage | Effective plan, status, limits, dates and flags on the `organizations` row; plan catalogue (defaults) in code; nullable billing refs. A billing provider later drives the **same commands** | A `subscriptions` table now: billing is not being built. Limits only in the plan: no per-org overrides for pilots. |
| D11 | Platform audit log | A **projection** (`platform_audit_log`) of every event whose actor is a super admin, plus system licensing actions; super-admin sign-ins and org-detail views are events too (low volume), so the log survives a rebuild | Operational table written by the route: lost or diverging on rebuild, and a second write path. |
| D12 | Workstations | Stay **user-owned and cross-org**. The `max_workstations` limit counts distinct workstations that host an active non-DevOps agent of the org, enforced at hire and rehome | `workstations.org_id`: one runner could not serve a user's two orgs. Counting all members' workstations: guests' and multi-org machines double count and pairing would be blocked by an org the user is not working in. |

---

## 1. Concepts after the change

| Concept | Meaning |
| --- | --- |
| **Organization** | Owns projects, agents, catalogue, desk, ledger, vaults, schedules, interests. Has exactly one Owner. Has plan, status, limits, dates, feature flags |
| **Org roles** (`org_members.role`) | `owner` (exactly one, transferable), `admin` (manages members, projects and org settings), `member` (works in the projects they are given) |
| **Guest** | Not an org member; has active access to one or more projects of the org (today's sharing). Rank below Member |
| **Rank** | Owner 4 > Admin 3 > Member 2 > Guest 1, relative to one org. Used by the interest edit rule (§4.3) |
| **Super admin** | Platform account (`users.kind='super_admin'`), no org, sees org **metadata only** |
| **Active org** | The org the current browser tab works in (§5). Object routes (a card, project, agent by id) derive the org from the object, not from the active org |
| **Org-less account** | A user with no active membership (legacy users without data, or removed from their only org). Sees their guest projects and pending invitations only |

Invariants:

- Exactly one active `owner` per org (partial unique index).
- A `super_admin` never has `org_members` or `project_members` rows (checked in every command that adds one; 409 `super_admin_cannot_join`).
- An Owner cannot leave or be removed; ownership must be transferred first.
- A user cannot be both an org member and a guest of the same org: joining the org converts their guest rows to member rows (`direct = true`, role kept as `manager`).

---

## 2. Data model and migrations

Migration numbers: the last one is `1306_interests.sql`; `restructure.md` reserved `1310`-`1314`. This work is built first, so take the **next free numbers at build time** (expected `1307_organizations.sql`, `1308_org_fks.sql`) and shift the restructure numbers after them.

### 2.1 `1307_organizations.sql` (schema, no behaviour change)

```sql
CREATE TABLE organizations (
  id                        uuid PRIMARY KEY,                 -- = legacy user id for migrated orgs
  name                      text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  owner_user_id             uuid NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  status                    text NOT NULL CHECK (status IN ('trial','active','suspended','cancelled')),
  status_reason             text,                             -- 'manual' | 'trial_ended' | 'license_expired' | 'billing' | free text
  status_changed_at         timestamptz NOT NULL,
  plan                      text NOT NULL,                    -- key in packages/shared/src/orgs/plans.ts
  max_members               integer CHECK (max_members >= 1),        -- NULL = unlimited
  max_workstations          integer CHECK (max_workstations >= 0),
  max_agents                integer CHECK (max_agents >= 0),
  max_projects              integer CHECK (max_projects >= 0),
  trial_ends_at             timestamptz,
  license_expires_at        timestamptz,
  grace_days                integer NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 0 AND 90),
  features                  jsonb NOT NULL DEFAULT '{}',      -- {flagKey: boolean}; missing = plan default
  billing_provider          text,                             -- NULL | 'stripe' | ...   (not used yet)
  billing_customer_ref      text,
  billing_subscription_ref  text,
  created_via               text NOT NULL CHECK (created_via IN ('legacy_migration','invitation','cli')),
  created_at                timestamptz NOT NULL
);
CREATE INDEX organizations_status ON organizations (status);

CREATE TABLE org_members (
  org_id      uuid NOT NULL REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED,
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('owner','admin','member')),
  status      text NOT NULL CHECK (status IN ('active','removed')),
  invited_by  uuid REFERENCES users(id),
  joined_at   timestamptz NOT NULL,
  removed_at  timestamptz,
  PRIMARY KEY (org_id, user_id)
);
CREATE UNIQUE INDEX org_members_one_owner ON org_members (org_id) WHERE role = 'owner' AND status = 'active';
CREATE INDEX org_members_user ON org_members (user_id) WHERE status = 'active';

-- Users: platform kind; the app-wide role is retired (kept for audit and legacy replay).
ALTER TABLE users ADD COLUMN kind text NOT NULL DEFAULT 'user' CHECK (kind IN ('user','super_admin'));
ALTER TABLE users RENAME COLUMN role TO legacy_role;
ALTER TABLE users ALTER COLUMN legacy_role DROP NOT NULL;
ALTER TABLE users ADD COLUMN last_org_id uuid;                -- operational: default active org for new sessions

-- Invitations: three kinds share one table and one token flow.
ALTER TABLE invitations ADD COLUMN kind text NOT NULL DEFAULT 'legacy'
  CHECK (kind IN ('legacy','new_org','org_member'));
ALTER TABLE invitations ADD COLUMN org_id uuid REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED; -- org_member
ALTER TABLE invitations ADD COLUMN org_role text CHECK (org_role IN ('owner','admin','member'));   -- new_org => owner
ALTER TABLE invitations ADD COLUMN proposed_org_name text;                                          -- new_org
ALTER TABLE invitations ADD COLUMN org_terms jsonb;          -- new_org: {plan, status, limits, trialEndsAt, licenseExpiresAt, features}
ALTER TABLE invitations ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';                        -- org_member: initial projects
ALTER TABLE invitations ALTER COLUMN role DROP NOT NULL;     -- legacy only
ALTER TABLE invitations DROP CONSTRAINT invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check CHECK (role IS NULL OR role IN ('admin','member'));
DROP INDEX invitations_one_pending_per_email;
CREATE UNIQUE INDEX invitations_one_pending ON invitations (kind, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(email))
  WHERE status = 'pending';

-- Sessions: remembered active org (not authoritative, see section 5). No FK: sessions survive a rebuild.
ALTER TABLE auth_sessions ADD COLUMN active_org_id uuid;

-- Project access: how a row was granted (section 4.2). Existing rows are direct.
ALTER TABLE project_members ADD COLUMN direct boolean NOT NULL DEFAULT true;
ALTER TABLE project_members ADD COLUMN org_grant boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN created_by uuid REFERENCES users(id);

-- Org-level desk items addressed to one user (DevOps, vault conflict, workstation bottleneck).
ALTER TABLE desk_items ADD COLUMN addressee_user_id uuid REFERENCES users(id);

-- Events: per-user audience. ADD COLUMN is DDL, not an UPDATE, so the append-only trigger is not involved.
ALTER TABLE events ADD COLUMN user_id uuid;
ALTER TABLE events DROP CONSTRAINT events_audience_check;
ALTER TABLE events ADD CONSTRAINT events_audience_check CHECK (audience IN ('org','project','admin','user','system'));
CREATE INDEX events_user_seq ON events (user_id, seq) WHERE user_id IS NOT NULL;

-- Platform audit log (projection, section 9).
CREATE TABLE platform_audit_log (
  seq             bigint PRIMARY KEY,          -- the event's seq
  at              timestamptz NOT NULL,
  actor_kind      text NOT NULL,               -- 'user' (super admin) | 'system'
  actor_user_id   uuid REFERENCES users(id),
  action          text NOT NULL,               -- event type
  org_id          uuid,                        -- no FK: the log outlives anything
  target_user_id  uuid,
  invitation_id   uuid,
  summary         text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}', -- before/after for edits, reason
  ip              inet,
  user_agent      text
);
CREATE INDEX platform_audit_org ON platform_audit_log (org_id, seq DESC);
CREATE INDEX platform_audit_actor ON platform_audit_log (actor_user_id, seq DESC);
```

`audience = 'admin'` keeps its stored value and now means **platform** (super admins). Old `UserInvited`/`InvitationAccepted`/`UserRoleChanged` events stay in that audience.

Add `organizations`, `org_members`, `platform_audit_log` to `PROJECTION_TABLES`. `projections/rebuild.ts`: no new saved table (`auth_sessions.active_org_id` is carried in the saved rows; `users.last_org_id` joins the `_save_users` temp table).

### 2.2 `1308_org_fks.sql` (re-point the FKs)

For every `org_id` column that references `users(id)` (list in the header; `agent_card_stats`, `agent_review_log` and `hr_applied` in `0900` have none and get none):

```sql
ALTER TABLE projects DROP CONSTRAINT projects_org_id_fkey;
ALTER TABLE projects ADD CONSTRAINT projects_org_id_fkey FOREIGN KEY (org_id)
  REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
-- ... same for agents, cards, shifts, threads, desk_items, ledger_entries, vaults, devops_requests,
--     schedules, intakes, outbound, repo_requests, departments, role_definitions, workflow_versions,
--     role_extensions (0005), deploy_targets, phases, ba_tasks (1303), ba_signals (1304), hygiene_findings, interests, ...
```

The builder generates this list with `grep -n "org_id.*REFERENCES users" apps/server/migrations/*.sql` at build time (constraint names come from `pg_constraint`; use a `DO $$ ... $$` block that loops over `pg_constraint` where `confrelid = 'users'::regclass` and the column is `org_id`, so restructure-era tables are covered too). `NOT VALID` because the organizations table is still empty; the data migration validates (§2.3).

### 2.3 Data migration `orgs-2026-10` (`apps/server/src/data-migrations/orgs.ts`)

Runs at boot after SQL migrations and before the dispatcher, scheduler and HTTP listener (the same hook `restructure.md` §5.4 introduces; this design creates `data-migrations/index.ts` and the restructure adds to it). Idempotent: it skips any org id that already exists. Env `AOM_DATA_MIGRATIONS` (default on). Dry run: `pnpm --filter @aom/server orgs:migrate --dry-run` prints the plan.

1. **Find legacy orgs.** `L = SELECT DISTINCT org_id FROM (each org table) UNION SELECT DISTINCT org_id FROM events WHERE org_id IS NOT NULL`, minus existing `organizations.id`. Every value must be a `users.id` (assert; abort with a clear message otherwise).
2. **Per legacy org** `u ∈ L`, one `withAppendTx`, stream `org-<u>`, actor `system`, audience `org`, `orgId = u`:
   - `OrganizationCreated {orgId: u, name: "<display name>'s organization", ownerUserId: u, plan: 'legacy', status: 'active', limits: all null, features: {}, createdVia: 'legacy_migration'}`
   - `OrgMemberAdded {orgId: u, userId: u, role: 'owner', via: 'migration'}`
3. **App admins.** The legacy `users.legacy_role = 'admin'` gives no platform power any more. Each legacy admin is the Owner of their own org (step 2). No one is made an Admin of someone else's org by default (privacy: today the admin cannot see members' work). Q3 offers a merge option. The log line and the desk notice (step 6) say: "Run `superadmin:create` to manage accounts and organizations."
4. **Sharing becomes guest access.** Nothing to write: a `project_members` row of a user who is not a member of the project's org is a guest by definition (D8). Legacy owners keep their `role='owner'` direct row.
5. **Validate.** `ALTER TABLE ... VALIDATE CONSTRAINT ...` for every constraint from §2.2.
6. **Report.** One `DeskItemRaised` alert (kind `alert`, subkind `org_migrated`, org-level, `addressee_user_id = u`) per org: "Your workspace is now the organization '<name>'. You are its Owner. Rename it in Settings > Organization." Plus a server log summary: orgs created, org-less users, guests found.

**Projects created by future Members.** Because no org is merged by default, every legacy project creator is the Owner of the org the project is in, so the owner decision "keep their projects, Admin if they own projects" applies only if Q3 (merge) is chosen. In that case the merge sets the member's role to `admin` when they created any project of the target org (`projects.created_by`, legacy: the org's owner).

**Rebuild equality.** A rebuild replays legacy events (projects with `org_id = u`, owner rows for `u`), then the late `OrganizationCreated`/`OrgMemberAdded`. The deferred FKs are checked at commit. The `OrgMemberAdded(owner)` projector inserts `org_grant` rows for all of the org's projects; for the legacy owner the direct row already exists and only `org_grant` flips to true (`ON CONFLICT DO UPDATE`). Test: `orgs-migration.test.ts` builds the legacy fixture from events, migrates, snapshots every projection table, rebuilds, compares.

### 2.4 Projector rules that keep `project_members` correct (D6)

Effective row: `status = 'active'` if `direct_active OR org_grant`; `role = 'owner'` if `org_grant` else `'manager'`. Implemented in one helper `refreshProjectAccess(tx, projectId, userId)` in `projections/sharing.ts`.

| Event | Effect |
| --- | --- |
| `ProjectCreated` (new payload has `createdByUserId`) | Insert `org_grant` rows for every active Owner/Admin of `orgId`. Legacy payload (no `createdByUserId`): today's behaviour, owner row for `orgId` |
| `OrgMemberAdded` / `OrgMemberRoleChanged` to `owner`/`admin` | `org_grant = true` on every project of the org (insert or update) |
| `OrgMemberRoleChanged` to `member` | `org_grant = false`; rows without `direct` become `removed` |
| `OrgMemberRemoved` | `org_grant = false`, `direct = false` on all the org's projects (all removed) |
| `ProjectMemberAdded` (new, Owner/Admin adds an org Member: active at once) | `direct = true` |
| `ProjectShared` / `ProjectShareAccepted` (guests, unchanged events) | today's behaviour, `direct = true` |
| `ProjectMemberRemoved` | `direct = false`; row stays active only if `org_grant` |

---

## 3. Events

All in `packages/shared/src/events/org.ts` (new) unless noted. Stream `org-<orgId>` (`streamId.org`). Audience `org` with `orgId` set, except where noted. Platform events by a super admin carry `meta: {ip?, userAgent?}` for the audit log.

| Event | Payload | Audience | Projection |
| --- | --- | --- | --- |
| `OrganizationCreated` | `{orgId, name, ownerUserId, plan, status, limits:{maxMembers,maxWorkstations,maxAgents,maxProjects}, trialEndsAt?, licenseExpiresAt?, features, createdVia, invitationId?}` | org | insert `organizations` |
| `OrganizationRenamed` | `{orgId, name}` | org | name |
| `OrgMemberAdded` | `{orgId, userId, role, via:'invitation'|'migration'|'bootstrap', invitationId?, projectIds?}` | org | upsert `org_members`; §2.4; converts guest rows of this org to member rows |
| `OrgMemberRoleChanged` | `{orgId, userId, role:'admin'|'member'}` | org | role; §2.4 |
| `OrgMemberRemoved` | `{orgId, userId, reason:'removed'|'left'|'deactivated'}` | org | status removed; §2.4; agents managed by the user in this org → `manager_user_id = owner`, `needs_rehome`, no workstation (as `ProjectMemberRemoved`) |
| `OrgOwnershipTransferred` | `{orgId, fromUserId, toUserId}` | org | new owner `owner`, old owner `admin`, `organizations.owner_user_id` |
| `OrgStatusChanged` | `{orgId, status, reason, note?, meta?}` | org + platform log | status, status_reason, status_changed_at |
| `OrgPlanChanged` | `{orgId, plan, limitsReset:boolean, meta?}` | org | plan; when `limitsReset`, limits and features from the plan defaults |
| `OrgLimitsSet` | `{orgId, limits, meta?}` | org | limit columns |
| `OrgDatesSet` | `{orgId, trialEndsAt:null|iso, licenseExpiresAt:null|iso, graceDays?, meta?}` | org | dates |
| `OrgFeaturesSet` | `{orgId, features:{[key]:boolean|null}, meta?}` (null = back to plan default) | org | merge into `features` |
| `OrgInvitationCreated` (`events/user.ts`) | `{invitationId, kind:'new_org'|'org_member', email, orgId?, orgRole, proposedOrgName?, orgTerms?, projectIds?, tokenHash, expiresAt, invitedBy, meta?}` | `admin` for `new_org`; `org` for `org_member` | insert `invitations` |
| `InvitationResent`, `InvitationRevoked` (existing) | unchanged; the command picks the audience from the invitation kind | | unchanged |
| `OrgInvitationAccepted` (`events/user.ts`) | `{invitationId, userId}` | same as created | invitation accepted |
| `UserRegistered` (`events/user.ts`) | `{userId, email, displayName, passwordHash, invitationId}` | `user` (`userId`) | insert `users` (`kind 'user'`) |
| `SuperAdminCreated` (`events/user.ts`) | `{userId, email, displayName, passwordHash}` | admin | insert `users` (`kind 'super_admin'`) |
| `SuperAdminSignedIn` | `{userId, meta}` | admin | audit log only |
| `PlatformOrgViewed` | `{orgId, meta}` | admin | audit log only |
| `ProjectMemberAdded` (`events/sharing.ts`) | `{projectId, userId, addedBy}` | project | §2.4 |
| `DeskItemRaised` (existing) | gains optional `addresseeUserId` | | `desk_items.addressee_user_id` |

Changed payloads:

- `ProjectCreated` gains `createdByUserId?` (absent on legacy events = `orgId`).
- `UserDeactivated`/`UserReactivated` keep their shape; by a super admin they get `meta`.
- `UserBootstrapped` is no longer written (legacy replay only). `admin:create` writes `UserRegistered` + `OrganizationCreated` + `OrgMemberAdded` (§12).
- `EventScope` (`eventstore/types.ts`) gains `userId?: string | null`, required when `audience = 'user'`.

Re-scoped writers (new events only; legacy events keep their scope):

| Writer | Today | After |
| --- | --- | --- |
| `commands/workstations.ts` (paired, renamed, unlinked), `runner-gateway/*` (connected, disconnected, rotation) | `orgScope(user.id)` | `userScope(workstationUserId)` |
| `UserTimezoneChanged` | org | `user` |
| DevOps, vault-conflict and bottleneck desk items | org-level, owner = user | org-level with `addresseeUserId` = the workstation's user, `orgId` = the org the request is for |
| everything else written with `orgScope(user.id)` (16 sites, list in §16 step 5) | user id | `orgScope(org.id)` from the request's org context |

---

## 4. Authorization

### 4.1 Pure predicates (`packages/shared/src/authz/index.ts`, rewritten)

```ts
export type OrgRole = 'owner' | 'admin' | 'member';
export type Rank = 1 | 2 | 3 | 4;                       // guest 1, member 2, admin 3, owner 4
export interface Actor { userId: string; kind: 'user' | 'super_admin'; orgRole: OrgRole | null; isGuest: boolean }
export const isOrgManager = (a: Actor) => a.orgRole === 'owner' || a.orgRole === 'admin';
export const rankOf = (orgRole: OrgRole | null, isGuest: boolean): Rank | 0 => ...;
export const canCreateProject = isOrgManager;
export const canAddPeople = isOrgManager;               // org invitations and project access, members and guests
export function canEditInterest(a: Actor, creator: {userId: string; rank: Rank}, canView: boolean): boolean;
export function canEditSchedule(a: Actor, s: {projectId: string | null; projectMember: boolean}): boolean;
export function canSeeEvent(viewer: Viewer, ev: EventVisibility): 'full' | 'stripped' | false;
```

`userId === orgId` disappears from the codebase; a test greps for it (`authz-no-user-org.test.ts`).

### 4.2 Matrix

SA = super admin, O = Owner, A = Admin, M = Member, G = Guest. "proj" = only in projects the user is on (Members: given by O/A; Guests: shared with them). Org data of a **suspended** org: see §8.2.

| Action | SA | O | A | M | G |
| --- | --- | --- | --- | --- | --- |
| **Platform** | | | | | |
| List orgs, view org metadata and usage counts | yes | | | | |
| Invite a new user to start an org | yes | | | | |
| Suspend, reactivate, cancel an org | yes | | | | |
| Edit plan, limits, dates, grace, feature flags | yes | | | | |
| Deactivate / reactivate a platform login | yes (not an org Owner of an active org, §8.4) | | | | |
| View platform audit log | yes | | | | |
| Create a super admin | CLI only | | | | |
| Any org, project, card, desk, vault, ledger, chat, agent or event payload | **no** | | | | |
| **Organization** | | | | | |
| View org name, own role, banners | | yes | yes | yes | name only |
| View plan, limits and usage | | yes | yes | | |
| Rename org | | yes | yes | | |
| Invite members (`org_member`, role member) | | yes | yes | | |
| Invite or promote Admins, demote Admins | | yes | | | |
| Remove a Member | | yes | yes | | |
| Remove an Admin | | yes | | | |
| Transfer ownership (to an active member or admin; password re-entry) | | yes | | | |
| Leave the org | | transfer first | yes | yes | (leave project) |
| List members (name, email, role) | | yes | yes | yes | |
| List guests across the org's projects | | yes | yes | | |
| Org reporting settings, budgets (restructure roadmap) | | yes | yes | | |
| Billing (future) | | yes | | | |
| **Projects** | | | | | |
| Create a project | | yes | yes | no | no |
| See and work in a project (board, cards, threads, project desk) | | all | all | proj | proj |
| Add people to a project: org Members (active at once) and Guests (invite/accept) | | yes | yes | no | no |
| Remove someone from a project | | yes | yes | no | leave self |
| Update settings, repos, register project vault, delete (archived) | | yes | yes | | |
| Archive / restore | | yes | yes | proj | proj |
| Create card, comment | | yes | yes | proj | proj |
| Manage card (edit, priority, policy, cancel, re-home, move, release) | | yes | yes | own cards | own cards |
| Answer card desk item | per card policy (`owner_only` = card owner; `any_manager` = any project member) | | | | |
| Answer project-level desk item | | yes | yes | | |
| Org-level desk items (no project) | | yes | yes | addressed to them | addressed to them |
| Standing orders: project-wide / org-wide | | yes / yes | yes / yes | | |
| **Agents** (org-wide, per-agent allow-list, `restructure.md`) | | | | | |
| Hire | | yes, any allow-list | yes, any allow-list | onto own workstation, allow-list within proj | onto own workstation, allow-list within shared proj |
| Change, fire, rehome, permissions (narrow) | | any org agent | any org agent | own hires | own hires |
| Widen permissions | | yes | yes | | |
| Direct / chat | | any | any | agents allowed on a proj, in that project's context | same |
| **Catalogue and org designer** | | | | | |
| Custom roles, workflows, departments | | yes | yes | read | read (project's workflow) |
| **Vaults and workstations** | | | | | |
| Org-level vaults: register, settings | | yes | yes | | |
| Own workstations: pair, rename, unlink, DevOps access | own | own | own | own | own |
| **Interests** (owner decision 2026-10-06) | | | | | |
| View interest, runs, digest, taste | | members of the interest's backing project (unchanged) | | | |
| Create | | yes | yes | yes (in a project they are on, or private) | yes, private unless shared (restructure Q3) |
| Edit, delete, pause, taste rules, run now, archive | creator's rank ≤ own rank, and may view (§4.3) | | | | |
| **Schedules** (owner decision 2026-10-06) | | | | | |
| Project-bound actions (create card, regression run, project-bound integration, project BA brief) | | yes | yes | proj | shared proj only |
| Org-level actions (BA tasks not bound to a project, hygiene sweep, org integrations) | | yes | yes | no | no |
| DevOps / workstation-targeted actions | | additionally: the target workstation's user | | | |

### 4.3 Interest edit rule

`canEditInterest(actor, creator)` = `canView && (actor.userId === creator.userId || rank(actor) >= rank(creator))`. Order Owner > Admin > Member > Guest, ranks evaluated in the **interest's org** (the backing project's org).

- `interests` gains `created_by_rank smallint` (the creator's rank at creation; `InterestCreated` gains `creatorRank`) next to the existing `created_by`.
- **Recommended default: the creator's current rank counts** while the creator still has a relationship with the org (member or guest with an active project there); the stored rank is the fallback when they have none (left, removed, deactivated). Reason: promotion and demotion should carry authority both ways (a demoted Admin's interests become editable by Members; a promoted Member's become protected), and a departed creator must not freeze an interest at an unreachable rank forever. The stored rank also keeps the rule deterministic in the audit trail.
- The creator may always edit their own interest while they can view it.
- Taste rules of an interest follow the interest. A project's own taste rules (non-interest) follow the project: O/A and project members as today.

### 4.4 Guard functions (`apps/server/src/auth/guards.ts`)

| Guard | Returns / throws |
| --- | --- |
| `requireUser` | unchanged; additionally 403 `super_admin_platform_only` when `kind='super_admin'` |
| `requireSuperAdmin` | session of a super admin, else 404 (platform routes do not advertise themselves) |
| `requireOrg(ctx, req, {min?: 'member'|'admin'|'owner', allowSuspended?})` | `{session, org, role}` from the request org (§5); 403 `org_forbidden`, 403 `org_suspended` (§8.2), 403 `org_role_required` |
| `requireFeature(org, key)` | 403 `feature_disabled` |
| `requireAdmin` | removed; `/api/admin/*` becomes `/api/platform/*` and `/api/org/*` |

Object routes (`loadVisibleProject`, `loadVisibleCard`, `manageableAgent`) keep their joins (D6) and additionally load `organizations.status` of the object's org for the suspension check, and the actor's org role for O/A rights (`orgRoleOf(db, userId, orgId)` in `authz/scope.ts`).

---

## 5. Sessions and the active org

- **Per request.** The web client sends `X-AOM-Org: <orgId>` on every `/api` request (from `sessionStorage`, so each tab keeps its own org). The server resolves the request org as: header (must be an active membership, else 403 `org_forbidden`) → `auth_sessions.active_org_id` → `users.last_org_id` → the user's oldest active membership → none (org-less).
- **Switching.** `POST /api/orgs/active {orgId}` stores `auth_sessions.active_org_id` and `users.last_org_id` (operational, no event), returns the new `me`. The client writes `sessionStorage`, clears the query cache and reconnects the WebSocket. Other tabs are unaffected (their header wins).
- **Org-scoped vs object routes.** Lists and creates that have no object (agents list, desk, ledger, catalogue, vaults, schedules, interests, reporting, metrics, `POST /api/projects`, hire) use the request org. Routes on an object (`/api/projects/:id`, `/api/cards/:id`, `/api/agents/:id`) use the object's org, so a deep link into another org or a guest project works; the web shows "This card is in Acme" with a "Switch to Acme" action when it differs from the tab's org.
- **WebSocket.** `/api/ws?org=<orgId>` (validated like the header). Visibility (§6) is computed for that org. A switch closes and reopens the socket (resync from the client's last seq is not attempted across orgs; the client resets).
- **Project keys.** Keys are unique per org. `/p/:key` resolves in the tab's org first, then the user's guest projects; if two guest projects share the key, the project switcher's choice (stored per tab) wins and the URL gains `?org=<id>`.
- **Super admin sessions** use the same cookie and table, absolute 12 h and idle 1 h (`ctx.config`), and `/api/auth/me` returns `account.kind = 'super_admin'` so the web routes to `/platform`.
- **Login gating** (§8.2) happens in `verifyLogin` after the password check, so it never reveals org state to a wrong password.

`/api/auth/me` (`MeResponseSchema`):

```ts
{
  user, account: { kind: 'user' | 'super_admin' },
  isAdmin: boolean,                 // deprecated alias for one release: activeOrg.role in (owner, admin)
  orgs: [{ id, name, role, status }],          // memberships; suspended ones flagged
  activeOrg: null | { id, name, role, status, plan, features, limits, usage, banners: Banner[] },
  guestProjectIds: string[],
  visibleProjectIds: string[],      // unchanged meaning (all orgs)
  pendingInvitations: number,       // org_member invitations to this email + project shares
  features: { mockUi },
}
```

`usage` and `limits` are returned only to O/A; `banners` to everyone (Members see "suspended" only).

---

## 6. Event visibility

`EVENT_VISIBILITY_SQL` (`authz/scope.ts`) becomes, with `$1` user, `$2` isSuperAdmin, `$3` visible project ids, `$4` socket org, `$5` org role in `$4`:

```sql
(
     (audience = 'org'     AND org_id = $4 AND $5::text IS NOT NULL)   -- O/A full, M stripped (below)
  OR (audience = 'project' AND project_id = ANY($3::uuid[]))
  OR (audience = 'user'    AND user_id = $1)
  OR (audience = 'admin'   AND $2::boolean)
)
```

`canSeeEvent` (shared) returns `'full' | 'stripped' | false`. `'stripped'` for `audience='org'` when the role is `member`: `toVisibleEvent` sends `{seq, type, streamId, actor, projectId, createdAt, payload: {}}`. `ws/invalidate.ts` must not need payload fields for org events; the builder checks every org event handler there and falls back to invalidating the whole query key when the payload is empty.

Super admins see `admin` audience only: platform events and legacy invitation/user events (credential hashes are already redacted). Never `org`, `project` or `user`.

`DESK_VISIBLE` (`queries/desk.ts`):

```sql
((d.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active'))
 OR (d.project_id IS NULL AND d.org_id = $2 AND ($3 IN ('owner','admin') OR d.addressee_user_id = $1)))
AND d.triage <> 'pending'
```

Legacy org-level items have no addressee and remain visible to the legacy owner (who is the org's Owner).

Browser gateway (`browser-gateway/gateway.ts`): the `WorkstationConnected/Disconnected` special case keys on `e.scope.userId` (new) or legacy `e.scope.orgId === c.userId`; `s.org_id === c.userId` (line ~171) becomes an org-role check. On `OrgMemberRemoved`, `OrgMemberRoleChanged`, `OrgStatusChanged` and `ProjectMemberRemoved` the gateway recomputes the affected sockets' visibility (it already does this for project removal) and sends `resync`.

---

## 7. Licensing

### 7.1 Plans (`packages/shared/src/orgs/plans.ts`)

```ts
export const ORG_FEATURES = ['interests','integrations','outbound','research','phases','browserTools','customRoles'] as const;
export const PLANS = {
  legacy: { name: 'Legacy',  limits: {all null}, features: {all true} },
  trial:  { name: 'Trial',   limits: {maxMembers: 5, maxWorkstations: 3, maxAgents: 10, maxProjects: 5}, features: {...} },
  team:   { name: 'Team',    limits: {...}, features: {...} },
  custom: { name: 'Custom',  limits: {all null}, features: {all true} },
};
export function effectiveFeatures(plan, overrides): Record<Feature, boolean>;
```

The row stores the **effective** limits (editable per org); changing the plan offers "reset limits and flags to the plan defaults" (`OrgPlanChanged.limitsReset`). Plan values are placeholders the owner sets (Q8).

### 7.2 Status semantics

| Status | Dispatch, scheduler, interests | Logins | Writes |
| --- | --- | --- | --- |
| `trial` | yes | yes | yes |
| `active` | yes | yes | yes |
| `suspended` | **no new claims**; in-flight shifts finish (Q5); scheduled fires skipped and recorded as `skipped: org_suspended` | Owner only (others: §8.2) | Owner: read, org settings, members; no card or project writes (409 `org_suspended`) |
| `cancelled` | no; in-flight shifts are released | Owner only, read-only (export) | none |

### 7.3 Dates

- `trial_ends_at` passes → the scheduler tick (`scheduler/scheduler.ts`, a new `licensingTick` every 5 minutes) appends `OrgStatusChanged {status:'suspended', reason:'trial_ended'}` (actor `system`).
- `license_expires_at` passes → banner "expired, grace until <date>"; after `grace_days` → `OrgStatusChanged {suspended, reason:'license_expired'}`.
- Warnings: banners to O/A from 14 days before; desk alerts (org-level, no addressee, so O/A) at 14, 3 and 1 days, deduplicated by the desk fingerprint `license:<kind>:<date>:<threshold>`.
- Moving a date forward (super admin) on a system-suspended org reactivates it only if the super admin chooses "Reactivate" too (explicit, audited).

### 7.4 Limits and enforcement points (`apps/server/src/orgs/limits.ts`)

`usage(org)` and `assertWithinLimit(tx, org, kind, delta=1)` (409 `limit_reached` with `{limit, used, max}`), always inside the command transaction with `SELECT ... FROM organizations WHERE id=$1 FOR UPDATE` to serialize concurrent adds.

| Limit | Counts | Enforced at |
| --- | --- | --- |
| `max_members` | active `org_members` + pending `org_member` invitations (guests are not counted) | create org invitation, accept org invitation (re-check), merge |
| `max_projects` | projects of the org with `status='active'` (interest backing projects excluded after the restructure) | create project, restore from archive, convert (restructure) |
| `max_agents` | agents with `status <> 'retired'` and `NOT is_devops` | hire, rehire |
| `max_workstations` | distinct `workstation_id` of active non-DevOps agents of the org | hire, rehome onto a workstation not yet counted |

Lowering a limit below usage never removes anything: it shows "over limit" (banner to O/A) and blocks further additions.

### 7.5 Feature flags

`requireFeature(org, key)` on the routes of that feature (interests, integrations/intake polling, outbound, research, phases, browser tools, custom roles), and the dispatcher/scheduler skip work of a disabled feature. `me.activeOrg.features` drives nav and buttons. Turning a flag off hides and stops; data is kept.

### 7.6 Dispatcher and scheduler

- `dispatcher/candidates.ts`: `JOIN organizations o ON o.id = c.org_id AND o.status IN ('trial','active')`.
- `dispatcher/ba-tasks.ts`, reporter, hygiene, interest cadence and schedules: the same org status filter.
- Runner gateway: an RPC from a shift of a suspended org still completes (in-flight rule); `cancelled` releases claims (`ClaimReleased(org_cancelled)`).

### 7.7 Billing mapping (future, not built)

| Provider concept (Stripe) | Here |
| --- | --- |
| Customer | `billing_customer_ref` |
| Subscription | `billing_subscription_ref`; webhooks call the same commands as the super admin with actor `system`, `reason: 'billing'` |
| Price / product | `plan` key (mapping table in config) |
| `trialing` / `active` / `past_due` / `unpaid`, `paused` / `canceled` | `trial` / `active` / `active` + banner, grace / `suspended` / `cancelled` |
| `trial_end`, `current_period_end` | `trial_ends_at`, `license_expires_at` |
| Seat quantity | `max_members` |
| Entitlements | `features` |

---

## 8. Invitation flows

### 8.1 Three kinds

| | New organization | Org member | Project guest (unchanged mechanics) |
| --- | --- | --- | --- |
| Who sends | super admin | org Owner (any role), Admin (role member) | org Owner or Admin of the project's org |
| To | any email without a super admin account | any email | an **existing** account that is not a member of the org |
| Carries | proposed org name, plan, status (trial/active), limits, dates, flags | org, role, initial project ids | project |
| Token | yes (7 days, single use, `/invite/:token`) | yes | no: in-app accept on Projects (as today) |
| Accept, new account | name + password → `UserRegistered`, `OrganizationCreated`, `OrgMemberAdded(owner)`, `OrgInvitationAccepted` | name + password → `UserRegistered`, `OrgMemberAdded`, `ProjectMemberAdded` per project, `OrgInvitationAccepted` | n/a |
| Accept, existing account | sign in with that email, then "Create <org>" → same minus `UserRegistered` | sign in, "Join <org>" | Accept / Decline on Projects |
| Limit checks | none (super admin sets terms) | `max_members` at create and accept | none |
| Audience | `admin` (platform log) | `org` | `project` |

Rules:

- The email must match the signed-in account for the existing-account path (403 `invitation_email_mismatch`; the page offers "Sign out and continue").
- Accepting as a new account when the email already has an account: 409 `user_exists` with "Sign in to accept".
- A guest who accepts an `org_member` invitation becomes a member; their guest rows in that org become member rows (D-invariants).
- The invitee may edit the proposed org name on the accept page (new org).
- Legacy pending `legacy` invitations (app-wide admin invites) still accept: they create the user **and an org of their own** (`OrganizationCreated` with `createdVia:'invitation'`, Owner), which is what today's behaviour amounts to. No new legacy invitations can be created.
- Project sharing (`POST /api/projects/:id/members {email}`): O/A only now (owner decision). If the email is an active member of the org → `ProjectMemberAdded` (active, no accept step). Otherwise an existing account → today's `ProjectShared` guest invitation. Unknown email → 404 `user_not_found` with the hint "Invite them to the organization first, or ask them to sign up".

### 8.2 Login gating

After the password check, `verifyLogin` refuses with 403 `org_suspended` ("Your organization <name> is suspended. Contact <owner name>.") only when the user is a member of at least one org, **every** org they are a member of is suspended or cancelled and they are not its Owner, **and** they have no guest project in a usable org. Otherwise login succeeds; suspended orgs show greyed in the switcher and `requireOrg` refuses them for non-owners. Guests of a suspended org lose those projects (they disappear from lists; direct links 403 `org_suspended`).

### 8.3 Membership removal side effects (`commands/orgs.ts removeOrgMemberIn`)

In one transaction: `ProjectMemberRemoved` for each of their direct rows in the org's projects (reuses `removeMemberIn`: claims released, cards re-owned by the org Owner), `OrgMemberRemoved`, and `AgentRetired` for the org's DevOps agents on their workstations. Their other orgs are untouched.

### 8.4 Super admin deactivating a user

`PATCH /api/platform/users/:id {status:'deactivated'}` runs today's `patchUser` deactivation path (memberships, workstations, sessions). It is refused (409 `user_owns_org`, with the org list) when the user is the Owner of an org whose status is `trial` or `active`; the super admin suspends the org first (Q6 offers platform-side ownership transfer).

---

## 9. Platform audit log

Projector `projections/platform-audit.ts` writes one row for:

- every event with `actor.kind='user'` whose actor is a super admin (`OrgStatusChanged`, `OrgPlanChanged`, `OrgLimitsSet`, `OrgDatesSet`, `OrgFeaturesSet`, `OrganizationRenamed`, `OrgInvitationCreated` (new_org), `InvitationResent`/`Revoked` of new_org invitations, `UserDeactivated`/`Reactivated`, `SuperAdminSignedIn`, `PlatformOrgViewed`);
- system licensing actions (`OrgStatusChanged` by `licensingTick`), so the log explains every status change;
- `OrganizationCreated` (any origin) and `OrgOwnershipTransferred` (metadata the platform needs).

`summary` is rendered server-side ("Suspended Acme: unpaid invoice"); `details` holds `{before, after}` for edits (the command puts the previous values into the event payload as `previous`). `ip`/`user_agent` from `meta`. The log is append-only by construction (projection of the event log) and survives a rebuild. The super admin's own reads are logged (`PlatformOrgViewed`, at most once per org per actor per 10 minutes, to keep volume down). Retention: forever (Q9).

---

## 10. API routes

Shared schemas in `packages/shared/src/api/{orgs,platform}.ts`. All org routes take the request org (§5).

**Platform** (`routes/platform.ts`, `requireSuperAdmin`):

| Route | |
| --- | --- |
| `GET /api/platform/orgs?status=&q=&sort=` | `{orgs: OrgSummaryDto[]}`: id, name, owner {name, email}, memberCount, status, plan, limits, usage {members, projects, agents, workstations}, trialEndsAt, licenseExpiresAt, createdAt, lastActiveAt (`SELECT created_at FROM events WHERE org_id=$1 ORDER BY seq DESC LIMIT 1`) |
| `GET /api/platform/orgs/:id` | summary + features, graceDays, statusReason, billing refs, shifts in the last 30 days (count), recent audit rows. Appends `PlatformOrgViewed` |
| `PATCH /api/platform/orgs/:id` | `{name?, plan?, limitsReset?, limits?, trialEndsAt?, licenseExpiresAt?, graceDays?, features?}` → the matching events in one append |
| `POST /api/platform/orgs/:id/{suspend,reactivate,cancel}` | `{reason, note?}` |
| `GET/POST /api/platform/invitations` | new-org invitations: `{email, proposedOrgName, plan, status:'trial'|'active', limits?, trialEndsAt?, licenseExpiresAt?, features?}` |
| `POST /api/platform/invitations/:id/{resend,revoke}` | |
| `GET /api/platform/users?q=` | email, name, status, kind, orgCount, lastLoginAt |
| `PATCH /api/platform/users/:id` | `{status}` (§8.4) |
| `GET /api/platform/audit?orgId=&actorId=&action=&before=` | paged by seq |

**Org** (`routes/orgs.ts`):

| Route | Who |
| --- | --- |
| `GET /api/orgs` | any user: memberships |
| `POST /api/orgs/active {orgId}` | member of that org |
| `GET /api/org` | members (limits/usage for O/A) |
| `PATCH /api/org {name}` | O/A |
| `GET /api/org/members` | members |
| `PATCH /api/org/members/:userId {role}` | O (admin changes); 409 `owner_role_via_transfer` |
| `DELETE /api/org/members/:userId` | O; A for members; `/api/org/members/me` to leave |
| `GET /api/org/members/:userId/removal-preview` | O/A: agents, cards, claims affected |
| `POST /api/org/transfer-ownership {userId, password}` | O |
| `GET/POST /api/org/invitations`, `POST .../:id/{resend,revoke}` | O/A (A: role member only) |
| `GET /api/org/guests` | O/A: guest, projects, since |
| `POST /api/projects` | O/A (was: anyone) |
| `POST /api/projects/:id/members {email}` | O/A (§8.1) |

**Invitations** (`routes/invitations.ts`, public):

| Route | |
| --- | --- |
| `GET /api/invitations/:token` | `{kind, email, expiresAt, invitedBy, orgName?, proposedOrgName?, role?, accountExists}` |
| `POST /api/invitations/:token/accept {displayName, password, orgName?}` | new account; sets the session cookie |
| `POST /api/invitations/:token/accept-existing {orgName?}` | signed in, same email |

`/api/admin/*` is removed. For one release it answers 410 `moved` with `{to: '/platform' | '/settings/org'}`.

---

## 11. Web UI

Design system: `docs/design/ui/design-system.md` tokens and components (`Callout`, `Tabs`, `ConfirmDialog`, `EmptyState`, `Menu`, `StatusDot`, `Chips`). Statuses always have a text label (principle 3).

### 11.1 App shell changes

- **Org switcher** at the top of the sidebar, above the project switcher (`components/shell/OrgSwitcher.tsx`). Hidden when the user has one org and no guest projects; then the org name is a static label.
- **Banners** (`components/shell/OrgBanner.tsx`, `Callout` under the top bar): suspended (danger), cancelled (danger), trial/licence ending (warning, O/A), over limit (warning, O/A), "Viewing a guest project in <org>" (info).
- **Nav** (`nav-config.ts buildNav`): `Admin` is removed. Settings group gains `Organization` (`/settings/org`, all members; tabs per role). "New project" (Projects page) and "Invite"/"Share" controls render only when `activeOrg.role in (owner, admin)` (`canCreateProject`, `canAddPeople`). Feature flags hide Interests, Intake, Phases, Research.

```
+--------------------------------------+
| [G] Guildwise HQ                [<<] |
| +----------------------------------+ |
| | Acme Robotics            Owner v | |   <- org switcher
| +----------------------------------+ |
| | WEB  Web shop                  v | |   <- project switcher
| +----------------------------------+ |
| [ + New card ]                       |
| WORK  ...                            |
| ORGANIZATION  ...                    |
| KNOWLEDGE  ...                       |
| SETTINGS                             |
|   Organization                       |
| (avatar) Pieter   [Sign out]         |
+--------------------------------------+

Switcher open:
+----------------------------------+
| YOUR ORGANIZATIONS               |
| * Acme Robotics          Owner   |
|   Side projects          Owner   |
|   Globex                 Member  |
|   Initech       Suspended  (dim) |
| GUEST IN                         |
|   Hooli: API, Mobile             |
| -------------------------------- |
| 2 pending invitations  >         |
+----------------------------------+
```

Suspended banner (owner view):

```
+---------------------------------------------------------------------------+
| (!) Acme Robotics is suspended (trial ended on 2 Oct). Agents are not      |
|     picking up work and only you can sign in. Contact support to resume.  |
+---------------------------------------------------------------------------+
```

### 11.2 Org settings (`pages/OrgSettings.tsx`, `/settings/org`)

Tabs: General, Members, Invitations, Guests, Plan & limits. Members see General (read-only) and Members (read-only).

```
Organization                                             
[ General ] [ Members ] [ Invitations ] [ Guests ] [ Plan & limits ]

Members  3 of 5                                        [ Invite member ]
+------------------------+---------------------+---------+------------+------+
| Name                   | Email               | Role    | Projects   |      |
+------------------------+---------------------+---------+------------+------+
| Pieter Jordaan (you)   | pieter@acme.test    | Owner   | all        |      |
| Ada Lovelace           | ada@acme.test       | Admin v | all        | ...  |
| Linus T                | linus@acme.test     | Member v| WEB, API   | ...  |
+------------------------+---------------------+---------+------------+------+
 ... menu: Change projects, Remove from organization (preview dialog)

Invite member (dialog)
  Email      [ grace@acme.test            ]
  Role       (o) Member   ( ) Admin          <- Admin option: Owner only
  Projects   [x] WEB  [ ] API  [x] MOBILE    <- Members only
  [Cancel]                     [Send invitation]
  "4 of 5 seats used after this invitation."

Plan & limits (Owner, Admin; read-only)
  Plan     Team            Status  Active
  Licence  expires 1 Jan 2027 (in 87 days)
  +-------------+-------+-------+------------------+
  | Members     | 3     | 5     | [=====-----] 60% |
  | Projects    | 4     | 10    | [====------] 40% |
  | Agents      | 12    | 12    | [==========] Full|  <- warning colour + "Full"
  | Workstations| 2     | --    | unlimited        |
  +-------------+-------+-------+------------------+
  Features  Interests on . Integrations off . Phases on ...
  "To change your plan, contact your platform administrator."

General
  Name   [ Acme Robotics      ] [Save]
  Owner  Pieter Jordaan        [Transfer ownership...]   <- Owner only
  [Leave organization]                                   <- not Owner
```

### 11.3 Platform area (`/platform`, own shell `components/platform/PlatformShell.tsx`)

Nav: Organizations, Invitations, Users, Audit log. No project switcher, no work nav. A super admin never reaches the app shell (router guard).

```
+-------------------+--------------------------------------------------------------+
| Guildwise HQ      | Organizations                          [ Invite new org ]    |
| PLATFORM          | [Search........] Status [All v]  Plan [All v]                |
|  Organizations    | +----------------+-----------+------+---------+-------+-----+|
|  Invitations      | | Name           | Owner     | Mem. | Status  | Plan  |Last ||
|  Users            | +----------------+-----------+------+---------+-------+-----+|
|  Audit log        | | Acme Robotics  | Pieter J. | 3/5  | Active  | Team  | 2h  ||
|                   | | Globex         | Hank S.   | 8/-  | Trial,  | Trial | 1d  ||
| (avatar) Root     | |                |           |      | ends 9d |       |     ||
| [Sign out]        | | Initech        | Bill L.   | 2/3  |Suspended| Trial | 30d ||
+-------------------+--------------------------------------------------------------+

Org detail (/platform/orgs/:id)
  Acme Robotics   Active   Team                 [Suspend] [Cancel org]
  Owner  Pieter Jordaan <pieter@acme.test>      Created 6 Oct 2026, last active 2h ago
  Usage   Members 3/5 . Projects 4/10 . Agents 12/12 . Workstations 2/-- . Shifts (30d) 431
  [ Plan & limits ] [ Dates ] [ Features ] [ Audit ]
    Plan  [Team v]  [ ] reset limits and flags to plan defaults
    Max members [5]  projects [10]  agents [12]  workstations [  ] (empty = unlimited)
    [Save changes]  -> confirm dialog lists before/after, requires a reason

  "Platform administrators see organization metadata only."   (info Callout)

Invite new org (dialog)
  Email [            ]   Organization name [              ]
  Plan [Trial v]  Status (o) Trial ends [2026-11-05]  ( ) Active, licence expires [    ]
  > Limits and features (Disclosure, prefilled from plan)
  [Cancel]                                   [Send invitation]

Audit log
  [Org: any v] [Actor: any v] [Action: any v]
  6 Oct 14:02  root@platform   Suspended Initech: trial ended (reason)       203.0.113.4
  6 Oct 13:40  system          Trial ended for Initech, suspended
  6 Oct 11:15  root@platform   Changed Acme limits: agents 10 -> 12
```

### 11.4 Accept-invite flows (`pages/AcceptInvite.tsx`, rewritten)

```
New organization, no account          Org member, existing account (signed out)
+----------------------------------+  +------------------------------------+
| Start your organization          |  | Join Acme Robotics                 |
| You were invited by Guildwise HQ |  | Ada Lovelace invited you as Member |
| Organization name [Globex      ] |  | ada@acme.test already has an       |
| Your name         [            ] |  | account.                           |
| Password          [            ] |  | [ Sign in to accept ]              |
| Trial, 30 days                   |  +------------------------------------+
| [ Create organization ]          |
+----------------------------------+  Signed in, same email:
                                      | [ Join Acme Robotics ]  [Decline] |
Signed in with another email:         Expired/used: EmptyState "This invitation
"This invitation is for ada@...       is no longer valid. Ask <inviter> for a
 [Sign out and continue]"             new one."
```

Project guest invitations stay on the Projects page ("Shared with you: Accept / Decline"), with the org name shown ("Hooli invited you to API").

### 11.5 Hidden controls (Members and Guests)

"New project" (Projects page, empty state), "Invite" (Org settings), "Share"/"Add people" (project settings Members panel), role menus, "Remove" for others. The server enforces regardless.

---

## 12. CLI

| Command | Effect |
| --- | --- |
| `pnpm --filter @aom/server superadmin:create --email --name [--password]` | `SuperAdminCreated`. Refuses an email that has a user account |
| `pnpm --filter @aom/server admin:create --email --name [--password] [--org "Name"] [--plan legacy]` | **Repurposed:** creates a user and a new org they own (`UserRegistered` + `OrganizationCreated{createdVia:'cli'}` + `OrgMemberAdded(owner)`). Default org name "<name>'s organization", plan `legacy`, status `active`. Keeps the e2e setup and fresh installs working. Prints a hint about `superadmin:create` |
| `pnpm --filter @aom/server orgs:migrate [--dry-run]` | Runs or previews the data migration (§2.3) outside boot |
| `pnpm --filter @aom/server superadmin:reset-password --email` | Emergency reset; appends `PasswordChanged` with actor `system` (audited) |

---

## 13. Mock and e2e plan

**MSW (`apps/web/src/mocks`)**: `db.ts` gains orgs, memberships, invitations by kind, platform audit; `handlers.ts` `me` with `orgs/activeOrg`; new handlers for `/api/orgs*`, `/api/org/*`, `/api/platform/*`, invitation kinds. The mock user is Owner of "Acme" and Member of "Globex"; a `?as=member`, `?as=guest`, `?as=superadmin` query switch for UI review.

**Server tests (`apps/server/test`)**:

- `orgs-migration.test.ts`: legacy fixture (two users, one shared project, agents, vaults, desk, a pending legacy invitation, an org-less user) → migrate → assertions → rebuild equality → second run is a no-op.
- `org-authz.test.ts`: table-driven from the §4.2 matrix (each row × each role), 404/403 shapes.
- `org-visibility.test.ts`: replay and live fan-out per role; stripped payloads for Members; `user` audience; super admin sees nothing but `admin`.
- `org-members.test.ts`: invite, accept (new and existing), role change, transfer, leave, removal side effects, guest → member conversion.
- `licensing.test.ts` (test clock): trial end → suspension, grace, warnings dedupe, limits at each enforcement point with concurrency (two hires at `max-1`), dispatcher skips suspended orgs, login gating.
- `platform.test.ts`: routes, `PlatformOrgViewed` throttle, audit rows with before/after, `user_owns_org`.
- `interests-rank.test.ts` lands with the restructure (§17).

**E2E (Playwright, mock runtime, `e2e/tests`)**: global setup also runs `superadmin:create` (constants in `e2e/support/env.ts`).

- `platform.spec.ts`: super admin signs in → lands on `/platform` → invites a new org (mail captured by `support/mail.ts`) → invitee accepts and becomes Owner → super admin sets `max_members=2`, suspends → owner sees the banner, a member's login is refused, a card does not dispatch (mock runner) → reactivate → card dispatches → audit log lists every step.
- `org-members.spec.ts`: Owner invites a Member with one project → member sees only that project, has no "New project"/"Invite" → Owner promotes to Admin → Admin sees all projects → limit reached message.
- `org-switch.spec.ts`: a user in two orgs switches; two tabs on two orgs create a card each and both land in the right org.
- `sharing.spec.ts` (update): only O/A see "Share"; guest flow unchanged; guest sees the org label.
- `auth.spec.ts` (update): admin page tests move to `platform.spec.ts`.
- `guide-screenshots.spec.ts`: new shots for the switcher, org settings and platform pages.

---

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| A missed `user.id`-as-org site leaks or misfiles data (≈100 SQL predicates, 16 `orgScope(user.id)`, 10 `=== org_id` checks) | Step 5 inventory with a checklist in the PR; `authz-no-user-org.test.ts` greps for `orgScope(user.id`, `orgScope(s.user.id`, `orgId: user.id`, `=== user.id` next to `org_id`; the two-user isolation suite extended to two orgs with three roles |
| Deferred FKs hide a bad row until commit, far from the cause | Only org FKs are deferred; rebuild and migration tests catch violations; the error names the constraint |
| `NOT VALID` FKs left unvalidated if the data migration crashes | The migration validates as its last step and refuses to mark itself done until it has; boot refuses to start the dispatcher while `data_migrations` shows it pending |
| Stripped org events break a client invalidation that reads payload fields | Step 9 audits `ws/invalidate.ts`; fallback invalidates the whole key |
| Multi-tab header vs session confusion | Header is authoritative; the session value is only a default; e2e `org-switch.spec.ts` |
| Members gain more than before? (no: legacy users stay sole owners) / Guests lose sharing ability | Only O/A add people now (owner decision); legacy guests who used to own nothing are unaffected; legacy owners are Owners |
| Super admin account is a high-value target | CLI-only creation, short sessions, every action and view audited, no org data reachable by construction; TOTP is Q7 |
| Suspension mid-shift | In-flight shifts finish; cancelled releases claims; documented in the banner text |
| The restructure builder starts before this lands | §17 lists the steps that must wait; the restructure's data migration depends on `organizations` |
| Limits race | `FOR UPDATE` on the org row inside the command transaction |

---

## 15. Open questions (each with a recommended default)

1. **Multi-org per user?** Default: **yes**, per-tab active org via header (D5).
2. **Who gets an org in the migration?** Default: every user id that has org data (D3); data-less users become org-less accounts.
3. **Merge legacy members into the legacy admin's org** (one company deployment)? Default: **no**, each legacy user keeps their own org. Offer `orgs:merge --from <user> --into <org>` later; when used, a merged user who created projects becomes Admin (owner's recommended default).
4. **Can Members create projects behind an org setting?** Default: **no** (owner decision); no setting now.
5. **In-flight shifts on suspension**: Default: finish; no new claims. Cancel releases claims.
6. **May the super admin transfer an org's ownership** (support case, e.g. owner left the company)? Default: **yes**, to an existing Admin of that org, with a mandatory reason; audited. Needed to deactivate an owner (§8.4).
7. **Super admin MFA (TOTP)?** Default: not in v1; short sessions and audit. Add before offering hosted multi-tenant service.
8. **Plan catalogue values** (Trial/Team limits, trial length)? Default: Trial 30 days, 5 members, 3 workstations, 10 agents, 5 projects; Team unlimited workstations, 25 members, 50 agents, 25 projects. Owner to set.
9. **Audit log retention**: Default: forever (small).
10. **Do guests count toward `max_members`?** Default: **no**.
11. **Suspended org: Owner writes?** Default: read, org settings and members only; no card/project writes.
12. **Org-level vaults sync to Members' workstations?** Default: **no**, Owner/Admin workstations only; project vaults to project members as today.
13. **Interest creator's role change**: Default: **current rank counts**, stored rank as fallback (§4.3).
14. **Org-less users pairing a workstation**: Default: allowed; no DevOps auto-hire until they join an org; they can still host agents for guest projects.
15. **DevOps engineer per org**: Default: one per (org, workstation) for every org the workstation's user is an active member of; exempt from agent and workstation limits.

---

## 16. Implementation plan (ordered; each step ends green: `pnpm typecheck && pnpm lint && pnpm test`, e2e where noted)

1. **Shared contracts.** `packages/shared/src/orgs/{index,plans}.ts` (roles, rank, features, plans, banners); `events/org.ts` and the `events/user.ts` additions; `Audience` gains `user`; `ids.ts streamId.org`; `authz/index.ts` new predicates (§4.1) added **alongside** the old ones; `api/{orgs,platform}.ts`, `api/auth.ts` `MeResponse` additions (optional fields). Tests in `packages/shared/test`.
2. **Schema `1307_organizations.sql`** and projectors (`projections/orgs.ts`, `platform-audit.ts`, the `project_members` helper §2.4, users `kind`, invitation kinds, `ProjectCreated.createdByUserId`, desk addressee). `PROJECTION_TABLES`, `rebuild.ts`. Event store scope `userId`. Rebuild test. No route changes yet.
3. **FKs and data migration.** `1308_org_fks.sql`; `apps/server/src/data-migrations/{index,orgs}.ts`, boot hook in `main.ts`, `scripts/orgs-migrate.ts`. `orgs-migration.test.ts`.
4. **Org context.** `requireOrg`, `requireSuperAdmin`, `requireFeature`, header and WS `org` param, `POST /api/orgs/active`, `GET /api/orgs`, `/api/auth/me` v2 (keep `isAdmin` alias). Super admin blocked from app routes. Tests.
5. **Replace user-as-org.** Every `orgScope(user.id)` and `org_id = $n` bound to a user id switches to the request org or the object's org; `userId === orgId` predicates switch to org roles (`hr/hr.ts`, `commands/{agents,designer,vaults,sharing,ledger,devops,intake,hygiene,reporting,interests,workstations}.ts`, `queries/desk.ts`, `browser-gateway/*`, `chat/relay.ts`); workstation events to `user` audience; desk addressee for DevOps/vault/bottleneck items; DevOps auto-hire per org (Q15). `POST /api/projects` and project sharing O/A only. Remove the old predicates. `authz-no-user-org.test.ts`, isolation suite on two orgs.
6. **Event visibility.** `EVENT_VISIBILITY_SQL`, `canSeeEvent` tri-state, stripped payloads, `DESK_VISIBLE`, gateway resync on org events. `org-visibility.test.ts`.
7. **Org members and invitations.** `commands/orgs.ts` (invite, resend, revoke, accept new/existing, role change, remove, leave, transfer), `routes/orgs.ts`, invitation routes v2, mail templates per kind, legacy invitation acceptance path. `org-members.test.ts`.
8. **Super admin and platform.** `scripts/superadmin-create.ts`, `admin:create` repurposed, `routes/platform.ts`, new-org invitations, user deactivation rule, `PlatformOrgViewed`/`SuperAdminSignedIn`, audit queries. `/api/admin/*` → 410. `platform.test.ts`.
9. **Licensing enforcement.** `orgs/limits.ts` at every point in §7.4; status checks in `requireOrg`, object loaders and `verifyLogin`; dispatcher/scheduler/reporter/hygiene filters; `licensingTick`; feature flags on routes. `licensing.test.ts`.
10. **Web foundation.** API client header from `sessionStorage`, `me` v2 types, `OrgSwitcher`, `OrgBanner`, WS `org` param, query reset on switch, `buildNav` changes and hidden controls (§11.5), the guest/other-org label on project and card pages, MSW handlers and mock db. Web tests.
11. **Web org settings** (`pages/OrgSettings.tsx` and `components/org/*`). Web tests.
12. **Web platform area** (`pages/platform/*`, `PlatformShell`, router guard). Web tests.
13. **Web accept-invite** (all states in §11.4) and Projects page guest invitations with org names. Remove `pages/Admin.tsx`. Web tests.
14. **E2E.** Global setup `superadmin:create`; `platform.spec.ts`, `org-members.spec.ts`, `org-switch.spec.ts`; update `sharing.spec.ts`, `auth.spec.ts`, `guide-screenshots.spec.ts`. Full suite green.
15. **Docs.** `SPEC.md` (Users, workstations and administration; Expanding the organization), `ARCHITECTURE.md` §4, §5.2, §17, §19, §20, §21; `USER-GUIDE.md` (organizations, roles, invitations); `DEPLOY.md` (upgrade: backup, `superadmin:create`); mark this document as built.

---

## 17. Build before the restructure

`restructure.md` assumes "the org" exists: org-wide agents with project allow-lists, interests visible to "members" and creatable by "guests", per-project budgets, an org-level quiet cap and org-level schedules. Built on today's model, all of that would be written as `userId === orgId` and rewritten here a second time, and its data migration (`restructure-2026-10`, per org) would run against user ids before this migration re-points them. So: **this design's steps 1-9 land first** (the web steps 10-14 may run in parallel with restructure Part A). The restructure then takes the next free migration numbers and adds its data migration to the `data-migrations/index.ts` created here, ordered after `orgs-2026-10`.

The restructure steps that change are listed in `restructure.md` under "Impact of organizations".

---
## Owner decisions (2026-10-06 evening). These override the defaults above.
| # | Decision |
|---|---|
| 1 | Multi-org: **yes**, the active org is chosen per tab with an org switcher. |
| 2/3 | Migration: every user with org data becomes the Owner of their own org. Nobody is merged; a later `orgs:merge` command does that. |
| 4 | Only the Owner and Admins create projects. No setting changes this. |
| 5/11 | Suspension: running shifts finish and nothing new starts. Only the Owner can log in, with read access plus org settings and members. |
| 6 | The super admin can transfer ownership to an existing Admin, with a reason, audited. |
| 7 | **Two-factor login (TOTP) for everyone in v1:** **required for the super admin**, optional for all users, and **enforceable per org** by the Owner. Include recovery codes. |
| 8 | Plans: **one "Founding" plan with no limits for now**. The limit fields exist but are empty (unlimited) until pricing is decided. The trial and Team presets are not created yet. |
| 9/10 | The platform audit log is kept forever. Guests do not count toward the member limit. |
| 12 | Org-level vaults sync to Owner and Admin workstations only. |
| 13 | Interest edit rank uses the creator's **current** role, falling back to the stored role if they have left the org. |
| 14 | **Every user belongs to an organization.** A user either gets their own org (new-org invitation or migration) or is added as a member of an existing org. There are no org-less users (super admins excepted). **Guests can only be users who already hold an organization**: a guest invitation goes to an existing account that owns or belongs to an org. Inviting someone with no account goes through a member invitation (joins your org) or a new-org invitation from the super admin. The migration gives every existing user an org, including users without data (they become Owner of an empty org) or, if they only had shared access, an org of their own while their shared access becomes guest access. |
| 15 | One DevOps engineer per org per workstation, not counted against limits. |
| 15a | **The DevOps engineer cannot be extended.** It is free, so it must not become a general-purpose agent. Its built-in role takes no owner extensions: no extra instructions, skills, MCP tools, standing orders or custom permissions. It cannot be cloned into a custom role, cannot be given claimable workflow stages, and only works DevOps requests and hygiene. The server enforces this (reject the extension, clone and stage-assignment commands for role key `devops`), and the UI hides those controls. The model and effort can be changed. Any agent that is not the built-in DevOps engineer counts toward the agent limit. |
