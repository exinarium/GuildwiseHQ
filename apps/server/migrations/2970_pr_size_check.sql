-- PR size check (needs split) and the "timed out twice" mark. The pr_reviews columns and pr_split_notices are projections
-- of PrReviewNeedsSplit / PrReviewSplitCleared / PrReviewSplitNotice* / PrReviewTimedOutTwice / PrReviewAttentionCleared.
-- pr_open_changes is operational: the latest open pull request list per repository. No foreign keys.
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS split_reason text;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS split_at timestamptz;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS split_total integer;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS split_budget integer;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS split_unit text;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS split_members jsonb;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS attention text;

CREATE TABLE IF NOT EXISTS pr_split_notices (
  id uuid PRIMARY KEY,
  pr_review_id uuid NOT NULL,
  project_id uuid NOT NULL,
  check_id uuid NOT NULL,
  state text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  workstation_id uuid,
  queued_at timestamptz,
  review_url text,
  error_code text,
  error text,
  retryable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  posted_at timestamptz
);
CREATE INDEX IF NOT EXISTS pr_split_notices_open ON pr_split_notices (state) WHERE state IN ('pending','queued','failed');
CREATE INDEX IF NOT EXISTS pr_split_notices_pr ON pr_split_notices (pr_review_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pr_open_changes (
  project_repo_id uuid NOT NULL,
  change_id text NOT NULL,
  head_branch text NOT NULL,
  base_branch text NOT NULL,
  cross_repo boolean NOT NULL DEFAULT false,
  head_sha text,
  changed_lines integer,
  changed_files integer,
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (project_repo_id, change_id)
);

ALTER TABLE pr_review_polls ADD COLUMN IF NOT EXISTS complete boolean;
