-- Moving to a new server (docs/design/deploy-run-ux-design.md J6, v3).
-- A target is the server an environment deploys to (`active`), the old server kept as a fallback after a move (`standby`), or
-- let go (`retired`). Existing rows are `active`; an older event without a role leaves it so.
ALTER TABLE deploy_targets
  ADD COLUMN role text NOT NULL DEFAULT 'active' CHECK (role IN ('active','standby','retired')),
  ADD COLUMN retired_at timestamptz;

-- One row per move (projection of DeployTargetMove* events): what step it is at, what each step said (plain words, no secret
-- values), and the facts later steps need (the image, the port, the last backup).
CREATE TABLE deploy_target_moves (
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL,
  project_id        uuid NOT NULL,
  env_name          text NOT NULL,
  from_target_id    uuid NOT NULL,
  to_target_id      uuid NOT NULL,
  workstation_id    uuid NOT NULL,
  spec              jsonb NOT NULL,
  domain            text,
  state             text NOT NULL CHECK (state IN ('preparing','ready','moving','app_ready','completed','failed','cancelled')),
  current_step      text,
  steps             jsonb NOT NULL DEFAULT '[]'::jsonb,
  facts             jsonb NOT NULL DEFAULT '{}'::jsonb,
  error             text,
  old_app_stopped   boolean NOT NULL DEFAULT false,
  dns               text,
  started_by        uuid NOT NULL,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz
);
CREATE INDEX deploy_target_moves_project ON deploy_target_moves (project_id, started_at DESC);
-- (one open move per server is kept by the command, not by a unique index: a rebuild replays old moves and must never fail)
CREATE INDEX deploy_target_moves_from ON deploy_target_moves (from_target_id, state);
CREATE INDEX deploy_target_moves_to ON deploy_target_moves (to_target_id, state);
