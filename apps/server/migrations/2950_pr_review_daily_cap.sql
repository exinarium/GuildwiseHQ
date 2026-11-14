-- Daily cap on automatic PR reviews: the owner's cap per project, the size of each pull request, and how a run started.
ALTER TABLE projects       ADD COLUMN IF NOT EXISTS pr_review_daily_cap integer NOT NULL DEFAULT 20;
ALTER TABLE pr_reviews     ADD COLUMN IF NOT EXISTS changed_lines integer;
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS trigger text NOT NULL DEFAULT 'auto';
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS requested_by uuid;
CREATE INDEX IF NOT EXISTS pr_review_runs_auto_day ON pr_review_runs (project_id, started_at) WHERE trigger = 'auto';
