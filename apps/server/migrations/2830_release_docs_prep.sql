-- Release prep (docs and videos): the per-project switch and its runs. Off for every existing and new project.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS release_docs_prep jsonb NOT NULL
  DEFAULT '{"enabled": false, "steps": {}}'::jsonb;

CREATE TABLE IF NOT EXISTS release_docs_prep_runs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  release_branch text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'skipped')),
  steps text[] NOT NULL DEFAULT '{}',
  trigger text NOT NULL CHECK (trigger IN ('manual', 'retry', 'skip')),
  retry_of uuid,
  started_by uuid,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  failed_step text,
  failed_repo_id uuid,
  error text,
  skipped_by uuid,
  skipped_at timestamptz,
  updated_at timestamptz NOT NULL
);
-- One run per release at a time.
CREATE UNIQUE INDEX IF NOT EXISTS release_docs_prep_one_running
  ON release_docs_prep_runs (project_id, release_branch) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS release_docs_prep_latest
  ON release_docs_prep_runs (project_id, release_branch, started_at DESC);

CREATE TABLE IF NOT EXISTS release_docs_prep_repos (
  run_id uuid NOT NULL REFERENCES release_docs_prep_runs(id) ON DELETE CASCADE,
  repo_id uuid NOT NULL REFERENCES project_repos(id) ON DELETE CASCADE,
  branch text NOT NULL,
  main_branch text,
  workstation_id uuid,
  state text NOT NULL CHECK (state IN ('pending', 'running', 'passed', 'failed', 'skipped')),
  base_tag text,
  base_sha text,
  head_sha text,
  summary jsonb,
  commit_sha text,
  pushed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, repo_id)
);

CREATE TABLE IF NOT EXISTS release_docs_prep_steps (
  run_id uuid NOT NULL REFERENCES release_docs_prep_runs(id) ON DELETE CASCADE,
  repo_id uuid NOT NULL,
  step text NOT NULL,
  phase text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('pending', 'running', 'passed', 'failed', 'skipped')),
  command_id uuid,
  started_at timestamptz,
  finished_at timestamptz,
  files text[] NOT NULL DEFAULT '{}',
  error text,
  PRIMARY KEY (run_id, repo_id, step, phase)
);
