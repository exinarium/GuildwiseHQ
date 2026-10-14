-- Run environments (backlog #58): one row per started branch. OPERATIONAL data, not a projection: process state, ports
-- and health come from the runner's `run.status` messages (a rebuild of the projections leaves the table alone). Start,
-- stop and end are also events (RunEnvironmentRequested / StopRequested / Ended) for the chat, notifications and audit.
CREATE TABLE run_environments (
  id                 uuid PRIMARY KEY,
  org_id             uuid NOT NULL,
  project_id         uuid NOT NULL REFERENCES projects(id),
  workstation_id     uuid NOT NULL REFERENCES workstations(id),
  purpose            text NOT NULL CHECK (purpose IN ('manual','test')),
  card_id            uuid,
  -- [{repoId, branch, commit}]: the commit is filled in once the runner created the run worktrees
  sources            jsonb NOT NULL DEFAULT '[]',
  -- the services asked for (empty: all)
  services           text[] NOT NULL DEFAULT '{}',
  state              text NOT NULL CHECK (state IN
                       ('requested','preparing','starting','healthy','degraded','stopping','stopped','failed')),
  services_status    jsonb NOT NULL DEFAULT '[]',
  activity           text,
  plan_id            uuid,
  plan_version       integer,
  requested_by       uuid,
  devops_request_id  uuid,
  -- identifies the set of branches: a second start of the same set on the same workstation is refused
  branch_key         text NOT NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  healthy_at         timestamptz,
  expires_at         timestamptz,
  stop_requested_at  timestamptz,
  stopped_at         timestamptz,
  stop_reason        text,
  last_error         text
);
CREATE INDEX run_env_workstation ON run_environments (workstation_id, state);
CREATE INDEX run_env_project ON run_environments (project_id, created_at DESC);
CREATE INDEX run_env_card ON run_environments (card_id) WHERE card_id IS NOT NULL;
CREATE UNIQUE INDEX run_env_manual_live ON run_environments (workstation_id, project_id, branch_key)
  WHERE purpose = 'manual' AND state NOT IN ('stopped','failed');

-- What a runner can do and how many environments it holds (announced in `hello`, not an event).
CREATE TABLE workstation_capabilities (
  workstation_id       uuid PRIMARY KEY REFERENCES workstations(id),
  capabilities         text[] NOT NULL DEFAULT '{}',
  max_run_environments integer,
  updated_at           timestamptz NOT NULL
);
