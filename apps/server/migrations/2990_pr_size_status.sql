-- Hard size check: the commit status wanted and posted per open pull request, and the repositories that ever had one
-- (they keep getting a passing "inactive" status after the budget is removed). Operational, refreshed by polling.
CREATE TABLE IF NOT EXISTS pr_size_statuses (
  project_repo_id uuid NOT NULL,
  change_id text NOT NULL,
  head_sha text NOT NULL,
  state text NOT NULL,                 -- success | failure | pending
  reason text NOT NULL,                -- within | over | owner_exception | inactive | unknown
  description text NOT NULL,
  total integer,
  budget integer,
  unit text,
  post_state text NOT NULL,            -- pending | queued | posted | failed
  status_id uuid NOT NULL,             -- new for every change of (head_sha, state, description)
  attempts integer NOT NULL DEFAULT 0,
  workstation_id uuid,
  queued_at timestamptz,
  posted_at timestamptz,
  error_code text,
  error text,
  retryable boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_repo_id, change_id)
);
CREATE INDEX IF NOT EXISTS pr_size_statuses_open ON pr_size_statuses (post_state)
  WHERE post_state IN ('pending', 'queued', 'failed');
CREATE UNIQUE INDEX IF NOT EXISTS pr_size_statuses_status_id ON pr_size_statuses (status_id);

CREATE TABLE IF NOT EXISTS pr_size_status_repos (
  project_repo_id uuid PRIMARY KEY,
  first_posted_at timestamptz NOT NULL
);

-- The size check status tokens a workstation holds, as keys such as github@github.com (never a token).
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS status_tokens jsonb NOT NULL DEFAULT '[]'::jsonb;
