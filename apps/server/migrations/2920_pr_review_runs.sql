-- Reviewer runs on PR-only pull requests and their findings. Projections of PrReviewRun* / PrReviewPosted.
-- No foreign keys (projection rebuild). Never holds a token, a diff or file contents.
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS reviewed_by text;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS last_run_id uuid;
CREATE TABLE IF NOT EXISTS pr_review_runs (
  id uuid PRIMARY KEY,
  pr_review_id uuid NOT NULL,
  project_id uuid NOT NULL,
  reviewer text NOT NULL,
  runtime text NOT NULL,
  model text NOT NULL,
  workstation_id uuid,
  state text NOT NULL,
  timeout_ms integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  duration_ms integer,
  head_sha text,
  base_sha text,
  summary text,
  error_stage text,
  error_code text,
  error text,
  retryable boolean NOT NULL DEFAULT false,
  timed_out_by text,
  review_url text,
  posted_at timestamptz
);
CREATE INDEX IF NOT EXISTS pr_review_runs_pr ON pr_review_runs (pr_review_id, started_at DESC);
CREATE INDEX IF NOT EXISTS pr_review_runs_active ON pr_review_runs (state) WHERE state IN ('running', 'completed');
CREATE TABLE IF NOT EXISTS pr_review_findings (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  pr_review_id uuid NOT NULL,
  idx integer NOT NULL,
  path text NOT NULL,
  line integer,
  anchored boolean NOT NULL,
  severity text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  posted boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS pr_review_findings_run ON pr_review_findings (run_id, idx);
