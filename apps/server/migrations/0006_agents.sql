CREATE TABLE agents (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES users(id),
  project_id          uuid REFERENCES projects(id),   -- NULL = org-wide
  hired_by_user_id    uuid NOT NULL REFERENCES users(id),
  manager_user_id     uuid NOT NULL REFERENCES users(id),
  workstation_id      uuid REFERENCES workstations(id), -- NULL while needs_rehome
  name                text NOT NULL,
  role_key            text NOT NULL,
  role_version        integer NOT NULL,
  seniority           text NOT NULL CHECK (seniority IN ('junior','senior')),
  runtime             text NOT NULL,                  -- 'claude-code' | 'mock' | ...
  model               text NOT NULL,
  effort              text,                           -- 'low'|'medium'|'high'|'xhigh'|'max'
  skills              text[] NOT NULL DEFAULT '{}',
  permissions         jsonb NOT NULL DEFAULT '{}',    -- AgentPermissions
  capacity            smallint NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 8),
  is_devops           boolean NOT NULL DEFAULT false,
  status              text NOT NULL CHECK (status IN ('active','retired','needs_rehome')),
  hired_at            timestamptz NOT NULL,
  retired_at          timestamptz,
  last_shift_ended_at timestamptz
);
CREATE UNIQUE INDEX agents_name_per_org ON agents (org_id, lower(name));   -- includes retired: never reused
CREATE UNIQUE INDEX agents_one_devops ON agents (org_id, workstation_id) WHERE is_devops AND status = 'active';
