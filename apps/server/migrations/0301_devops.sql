-- M3: DevOps engineer requests and workstation access.
ALTER TABLE workstations
  ADD COLUMN devops_access jsonb NOT NULL
  DEFAULT '{"allowInstall":false,"allowDocker":false,"allowedPaths":[],"sudo":false}';

CREATE TABLE devops_requests (
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES users(id),     -- the workstation owner's org
  workstation_id    uuid NOT NULL REFERENCES workstations(id),
  devops_agent_id   uuid NOT NULL REFERENCES agents(id),
  thread_id         uuid NOT NULL,
  requested_by_kind text NOT NULL CHECK (requested_by_kind IN ('user','agent','system')),
  requested_by_id   text,
  requested_by_name text,
  card_id           uuid REFERENCES cards(id),
  summary           text NOT NULL,
  status            text NOT NULL CHECK (status IN ('queued','running','needs_approval','done','failed')),
  shift_id          uuid,                                   -- the DevOps shift currently working it
  approval          jsonb,                                  -- {deskItemId, action, reason, commands, resolution, note}
  result_summary    text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);
CREATE INDEX devops_requests_queue ON devops_requests (workstation_id, created_at) WHERE status = 'queued';
CREATE INDEX devops_requests_org ON devops_requests (org_id, created_at DESC);

CREATE TABLE environment_changes (
  id             uuid PRIMARY KEY,
  request_id     uuid REFERENCES devops_requests(id),
  workstation_id uuid NOT NULL REFERENCES workstations(id),
  summary        text NOT NULL,
  commands       text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL
);
CREATE INDEX environment_changes_ws ON environment_changes (workstation_id, created_at DESC);
