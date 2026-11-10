-- Regression loop: per-project switch (default off) and one row per failed regression run the loop follows.
-- Projections of ProjectRegressionLoopSet, FullSuiteFailed.loop, RegressionRedeployRequested, RegressionRequeued and
-- RegressionLoopStopped. No foreign keys (projection rebuild).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS regression_loop boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS regression_loops (
  run_card_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  platform text,
  workstation_id uuid,
  root_card_id uuid NOT NULL,
  iteration integer NOT NULL,
  mismatch boolean NOT NULL DEFAULT false,
  state text NOT NULL CHECK (state IN ('waiting_fixes', 'redeploying', 'requeued', 'stopped')),
  stop_reason text,
  devops_request_id uuid,
  next_run_card_id uuid,
  deployed_commit text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS regression_loops_open ON regression_loops (project_id)
  WHERE state IN ('waiting_fixes', 'redeploying');
CREATE UNIQUE INDEX IF NOT EXISTS regression_loops_next ON regression_loops (next_run_card_id)
  WHERE next_run_card_id IS NOT NULL;
