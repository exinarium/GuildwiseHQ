-- The timed-out run a manual re-run replaces. Projection of PrReviewRunStarted.rerunOfRunId. No foreign keys.
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS rerun_of_run_id uuid;
CREATE INDEX IF NOT EXISTS pr_review_runs_rerun_of ON pr_review_runs (rerun_of_run_id) WHERE rerun_of_run_id IS NOT NULL;
