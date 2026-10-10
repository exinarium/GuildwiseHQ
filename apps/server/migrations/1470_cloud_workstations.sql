-- Cloud workstations (docs/design/cloud-workstations-and-forges.md part 1; docs/RUNNER.md "Cloud workstations").
-- A machine somewhere else that runs our runner: a VPS reached over SSH, or a GitHub Codespace. Operational tables, not
-- projections: a projection rebuild never touches them. No SSH password, SSH key or Claude credential is ever stored.

CREATE TABLE cloud_workstations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  project_id         uuid,                       -- NULL: one for the whole organization (the default)
  user_id            uuid NOT NULL,              -- who set it up; owns the paired workstation
  provider           text NOT NULL CHECK (provider IN ('ssh','codespaces')),
  name               text NOT NULL,
  state              text NOT NULL DEFAULT 'installing'
                       CHECK (state IN ('installing','running','stopped','starting','stopping','failed','needs_attention')),
  state_detail       text NOT NULL DEFAULT '',
  workstation_id     uuid,                       -- the paired workstation (no foreign key: workstations is a projection)
  -- ssh: {host, port, username, hostFingerprint}; codespaces: {repo, machine, ref, devcontainerPath, codespaceName}
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  auth_mode          text NOT NULL DEFAULT 'api_key' CHECK (auth_mode IN ('api_key','subscription')),
  idle_minutes       integer NOT NULL DEFAULT 30 CHECK (idle_minutes BETWEEN 5 AND 240),
  office_hours       jsonb,                      -- {days, from, to, timezone} or NULL (any time)
  monthly_price_usd  numeric(12,2),              -- what the user says the VPS costs, for the estimate
  last_activity_at   timestamptz,
  last_wake_at       timestamptz,
  problem_notified_at timestamptz,               -- the desk notice and email for the current problem went out
  enroll_done_at     timestamptz,                -- a codespace enrolled once; a second enrollment is refused
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  removed_at         timestamptz
);
CREATE INDEX cloud_workstations_org ON cloud_workstations (org_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX cloud_workstations_codespace
  ON cloud_workstations ((config->>'codespaceName')) WHERE provider = 'codespaces' AND removed_at IS NULL;

-- A user's GitHub connection for Codespaces: the token (scope `codespace`) is needed later to start and stop the
-- codespace, so it is kept encrypted (AES-256-GCM, AOM_SECRET_KEY). It never leaves the server.
CREATE TABLE cloud_github_connections (
  user_id    uuid PRIMARY KEY,
  login      text NOT NULL,
  token_enc  text NOT NULL,
  updated_at timestamptz NOT NULL
);
