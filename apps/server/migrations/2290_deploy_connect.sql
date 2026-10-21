-- Guided connect, dedicated deploy keys and server preparation (docs/design/deploy-run-ux-design.md v2).
-- What each workstation's dedicated key for a target is (PUBLIC parts only: the private key never leaves the workstation), and
-- the answers to the one-off operations the page started (host key scan, key, connect, revoke, prepare, check). Both are
-- projections of events (DeployTargetConnected, DeployKeyRevoked, DeployOpFinished).
CREATE TABLE deploy_target_keys (
  target_id               uuid NOT NULL,
  workstation_id          uuid NOT NULL,
  project_id              uuid NOT NULL,
  org_id                  uuid NOT NULL,
  fingerprint             text NOT NULL,
  public_key              text NOT NULL,
  alias                   text NOT NULL,
  method                  text NOT NULL,
  address                 text,
  ssh_user                text,
  port                    integer,
  host_key_fingerprint    text,
  state                   text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  added_at                timestamptz NOT NULL,
  revoked_at              timestamptz,
  revoked_by_workstation  uuid,
  PRIMARY KEY (target_id, workstation_id)
);
CREATE INDEX deploy_target_keys_project ON deploy_target_keys (project_id);

CREATE TABLE deploy_ops (
  command_id      uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL,
  target_id       uuid,
  workstation_id  uuid NOT NULL,
  kind            text NOT NULL,
  ok              boolean NOT NULL,
  result          jsonb,
  error           text,
  at              timestamptz NOT NULL
);
CREATE INDEX deploy_ops_project ON deploy_ops (project_id, at DESC);
