-- Delivery recipes and authorization (docs/design/ceo-front-door.md sections 9 and 12, step 2). Projection tables, rebuilt
-- from the `Delivery*`, `Gate*` and `Deploy*` events. No foreign keys into other projection tables (a rebuild TRUNCATEs them).

-- `instructions` (the prose DevOps request of a phase follow-up, unchanged) or `recipe` (the approved recipe in the project vault).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS delivery_mode text NOT NULL DEFAULT 'instructions';
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_delivery_mode_check;
ALTER TABLE projects ADD CONSTRAINT projects_delivery_mode_check CHECK (delivery_mode IN ('instructions','recipe'));

-- One row per project: what the workstation observed in `<folder>/delivery/` of the project vault and what the Owner approved.
CREATE TABLE delivery_recipes (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL,
  project_id       uuid NOT NULL,
  vault_id         text NOT NULL,
  path             text NOT NULL,
  status           text NOT NULL CHECK (status IN ('observed','approved','changed_unapproved','rejected','absent')),
  present          boolean NOT NULL DEFAULT true,
  observed_hash    text,
  observed_commit  text,
  approved_hash    text,
  approved_commit  text,
  approved_by      uuid,
  approved_at      timestamptz,
  version          integer NOT NULL DEFAULT 0,
  parsed           jsonb,
  lint             jsonb NOT NULL DEFAULT '[]',
  file_count       integer NOT NULL DEFAULT 0,
  files            jsonb NOT NULL DEFAULT '[]',
  approved_files   jsonb NOT NULL DEFAULT '[]',
  -- the parsed recipe as it was when it was approved: what a run uses (the observed one may already differ)
  approved_parsed  jsonb,
  observed_at      timestamptz,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX delivery_recipes_project ON delivery_recipes (project_id);
CREATE INDEX delivery_recipes_org ON delivery_recipes (org_id, status);

CREATE TABLE gate_presets (
  org_id      uuid NOT NULL,
  name        text NOT NULL,
  gate        jsonb NOT NULL,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (org_id, name)
);

CREATE TABLE gate_bindings (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL,
  project_id  uuid,
  repo_id     uuid,
  env_match   text NOT NULL CHECK (env_match IN ('production','*')),
  preset      text NOT NULL,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL
);
CREATE UNIQUE INDEX gate_bindings_scope ON gate_bindings (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(repo_id, '00000000-0000-0000-0000-000000000000'), env_match);

-- One row per (project, environment, target) request. `released_by` is the audit of who released it.
CREATE TABLE deploy_runs (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL,
  project_id       uuid NOT NULL,
  recipe_id        uuid NOT NULL,
  env              text NOT NULL,
  target_id        uuid,
  target_name      text NOT NULL,
  workstation_id   uuid,
  hash             text NOT NULL,
  vault_commit     text,
  commit           text,
  trigger          text NOT NULL,
  requested_by     jsonb NOT NULL,
  origin           jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL CHECK (status IN ('requested','waiting_release','queued','running','succeeded','failed','refused','cancelled')),
  released_by_policy text NOT NULL DEFAULT 'owner' CHECK (released_by_policy IN ('owner','ceo','auto')),
  waiting_for      text CHECK (waiting_for IN ('owner','ceo')),
  gate             jsonb,
  evidence         jsonb NOT NULL DEFAULT '[]',
  released_by      jsonb,
  health           jsonb,
  smoke            jsonb,
  result           jsonb,
  refusal          text,
  refusal_detail   text,
  missing          jsonb NOT NULL DEFAULT '[]',
  summary          text,
  log_tail         text,
  url              text,
  deployed_commit  text,
  trial            boolean NOT NULL DEFAULT false,
  dry_run          boolean NOT NULL DEFAULT false,
  phase_followup_id uuid,
  created_at       timestamptz NOT NULL,
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL
);
CREATE INDEX deploy_runs_project ON deploy_runs (project_id, created_at DESC);
CREATE INDEX deploy_runs_org_status ON deploy_runs (org_id, status, created_at DESC);
-- One open run per (project, environment, target): a later request for the same one coalesces to the newest commit.
CREATE UNIQUE INDEX deploy_runs_one_open ON deploy_runs (project_id, env, target_name)
  WHERE status IN ('requested','waiting_release','queued','running') AND NOT trial;

