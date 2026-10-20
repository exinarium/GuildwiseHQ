-- Guided deploy setup (docs/design/deploy-run-ux-design.md sections 4, 6 and 7).
-- The wizard's work in progress (latest wins), the setup the workstation read from delivery/setup.json, which guided
-- scripts were edited by hand, the last publish, the workstations' read-only probes and their ssh reachability.
CREATE TABLE delivery_setup_drafts (
  project_id      uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  setup           jsonb NOT NULL,
  custom_scripts  jsonb NOT NULL DEFAULT '{}',
  proposal_id     uuid,
  -- the last publish: {setupHash, commandId, at, by, status: pending|written|failed, error?, vaultCommit?}
  last_publish    jsonb,
  updated_by      uuid NOT NULL,
  updated_at      timestamptz NOT NULL
);

ALTER TABLE delivery_recipes ADD COLUMN setup jsonb;
ALTER TABLE delivery_recipes ADD COLUMN hand_edited text[] NOT NULL DEFAULT '{}';

CREATE TABLE deploy_probes (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL,
  target_id       uuid,
  workstation_id  uuid NOT NULL,
  scope           text NOT NULL CHECK (scope IN ('local','ssh_hosts','ssh_target')),
  host            text,
  report          jsonb,
  error           text,
  detail          text,
  at              timestamptz NOT NULL
);
-- the latest probe per project, target, workstation, scope and host
CREATE UNIQUE INDEX deploy_probes_latest ON deploy_probes
  (project_id, COALESCE(target_id, '00000000-0000-0000-0000-000000000000'::uuid), workstation_id, scope, COALESCE(host, ''));

CREATE TABLE deploy_target_connections (
  target_id       uuid NOT NULL,
  workstation_id  uuid NOT NULL,
  project_id      uuid NOT NULL,
  state           text NOT NULL,
  method          text NOT NULL DEFAULT 'existing_alias',
  host            text NOT NULL,
  detail          text,
  at              timestamptz NOT NULL,
  PRIMARY KEY (target_id, workstation_id)
);
