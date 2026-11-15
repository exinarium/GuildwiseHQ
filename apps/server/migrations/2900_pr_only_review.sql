-- PR-only review (switch per project repository) and the pull requests recorded for review.
-- project_repos.pr_only / pr_only_since: projection of ProjectRepoPrOnlySet. pr_reviews: projection of
-- PrReviewRecorded / PrReviewClosed. pr_review_polls: operational (the last open pull request list request per
-- repository). No foreign keys (projection rebuild).
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS pr_only boolean NOT NULL DEFAULT false;
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS pr_only_since timestamptz;
CREATE TABLE IF NOT EXISTS pr_reviews (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  project_repo_id uuid NOT NULL,
  change_id text NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  author text,
  head_branch text NOT NULL,
  base_branch text NOT NULL,
  opened_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  review_state text NOT NULL,
  closed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_reviews_repo_change ON pr_reviews (project_repo_id, change_id);
CREATE INDEX IF NOT EXISTS pr_reviews_open ON pr_reviews (project_repo_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS pr_review_polls (
  project_repo_id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  workstation_id uuid,
  state text NOT NULL CHECK (state IN ('pending', 'ok', 'failed', 'unsupported')),
  detail text,
  requested_at timestamptz NOT NULL,
  checked_at timestamptz
);
