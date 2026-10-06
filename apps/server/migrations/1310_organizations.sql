-- Organizations, org roles, the super admin, two-factor login and licensing (docs/design/organizations.md section 2.1).
-- Schema only: no behaviour change until the data migration `orgs-2026-10` has run. (The design expected 1307/1308;
-- 1307-1309 were taken, so the work starts at 1310 and the restructure's reserved numbers shift after it.)

CREATE TABLE organizations (
  id                        uuid PRIMARY KEY,                 -- = the legacy user id for migrated orgs
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
  require_two_factor        boolean NOT NULL DEFAULT false,   -- the Owner requires two-factor login of every member
  billing_provider          text,
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
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD COLUMN last_org_id uuid;                 -- operational: default active org for new sessions
ALTER TABLE users ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false;

-- Invitations: three kinds share one table and one token flow.
ALTER TABLE invitations ADD COLUMN kind text NOT NULL DEFAULT 'legacy'
  CHECK (kind IN ('legacy','new_org','org_member'));
ALTER TABLE invitations ADD COLUMN org_id uuid REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE invitations ADD COLUMN org_role text CHECK (org_role IN ('owner','admin','member'));
ALTER TABLE invitations ADD COLUMN proposed_org_name text;
ALTER TABLE invitations ADD COLUMN org_terms jsonb;
ALTER TABLE invitations ADD COLUMN project_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE invitations ALTER COLUMN role DROP NOT NULL;
ALTER TABLE invitations DROP CONSTRAINT invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check CHECK (role IS NULL OR role IN ('admin','member'));
DROP INDEX invitations_one_pending_per_email;
CREATE UNIQUE INDEX invitations_one_pending ON invitations
  (kind, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(email)) WHERE status = 'pending';

-- Sessions: remembered active org (not authoritative: the request header wins). No FK: sessions survive a rebuild.
ALTER TABLE auth_sessions ADD COLUMN active_org_id uuid;

-- Project access: how a row was granted. `direct` = an active direct grant (a share the user accepted, or a project
-- member added by an Owner or Admin); `org_grant` = projector-maintained row for the org's Owner and Admins.
ALTER TABLE project_members ADD COLUMN direct boolean NOT NULL DEFAULT true;
ALTER TABLE project_members ADD COLUMN org_grant boolean NOT NULL DEFAULT false;
UPDATE project_members SET direct = false WHERE status <> 'active';
ALTER TABLE projects ADD COLUMN created_by uuid REFERENCES users(id);
UPDATE projects SET created_by = org_id;                         -- legacy: the org's owner created it

-- Org-level desk items addressed to one user (DevOps, vault conflict, workstation bottleneck).
ALTER TABLE desk_items ADD COLUMN addressee_user_id uuid REFERENCES users(id);

-- Events: per-user audience. ADD COLUMN is DDL, not an UPDATE, so the append-only trigger is not involved.
ALTER TABLE events ADD COLUMN user_id uuid;
ALTER TABLE events DROP CONSTRAINT events_audience_check;
ALTER TABLE events ADD CONSTRAINT events_audience_check CHECK (audience IN ('org','project','admin','user','system'));
CREATE INDEX events_user_seq ON events (user_id, seq) WHERE user_id IS NOT NULL;

-- Interests: the creator's rank when the interest was created (the fallback of the edit rule, section 4.3).
ALTER TABLE interests ADD COLUMN created_by_rank smallint;

-- Platform audit log (projection of the events a super admin or the licensing tick caused). Kept forever.
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
  ip              text,
  user_agent      text
);
CREATE INDEX platform_audit_org ON platform_audit_log (org_id, seq DESC);
CREATE INDEX platform_audit_actor ON platform_audit_log (actor_user_id, seq DESC);

-- Boot data migrations that have run (apps/server/src/data-migrations). Operational: not rebuilt.
CREATE TABLE data_migrations (
  name          text PRIMARY KEY,
  completed_at  timestamptz NOT NULL,
  summary       jsonb NOT NULL DEFAULT '{}'
);
