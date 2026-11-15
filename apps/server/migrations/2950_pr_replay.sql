-- 20-PR replay (offline reviewer measurement) and the owner's review targets. Projections of PrReplay* and
-- ProjectReviewTargetsSet. Replay runs and findings live in pr_review_runs / pr_review_findings with replay_id set and
-- pr_review_id NULL; marks live in pr_review_finding_marks. No foreign keys (projection rebuild).
CREATE TABLE IF NOT EXISTS pr_replays (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  project_repo_id uuid NOT NULL,
  state text NOT NULL,
  request_id uuid NOT NULL,
  workstation_id uuid,
  started_by uuid NOT NULL,
  started_at timestamptz NOT NULL,
  reviews_done_at timestamptz,
  finished_at timestamptz,
  failure_reason text,
  failure_found integer,
  failure_detail text,
  result jsonb
);
CREATE INDEX IF NOT EXISTS pr_replays_project ON pr_replays (project_id, started_at DESC);
CREATE TABLE IF NOT EXISTS pr_replay_prs (
  id uuid PRIMARY KEY,
  replay_id uuid NOT NULL,
  idx integer NOT NULL,
  change_id text NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  author text,
  head_branch text NOT NULL,
  base_branch text NOT NULL,
  head_sha text NOT NULL,
  merge_commit_sha text NOT NULL,
  merged_at timestamptz NOT NULL,
  additions integer NOT NULL,
  deletions integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_replay_prs_idx ON pr_replay_prs (replay_id, idx);
CREATE TABLE IF NOT EXISTS pr_replay_finding_views (
  finding_id uuid PRIMARY KEY,
  replay_id uuid NOT NULL,
  first_shown_at timestamptz NOT NULL,
  last_shown_at timestamptz NOT NULL,
  shown_count integer NOT NULL DEFAULT 1
);
ALTER TABLE pr_review_runs ALTER COLUMN pr_review_id DROP NOT NULL;
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS replay_id uuid;
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS replay_pr_id uuid;
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pr_review_runs_one_parent') THEN
    ALTER TABLE pr_review_runs ADD CONSTRAINT pr_review_runs_one_parent
      CHECK ((pr_review_id IS NULL) <> (replay_pr_id IS NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS pr_review_runs_replay ON pr_review_runs (replay_id, replay_pr_id, reviewer) WHERE replay_id IS NOT NULL;
ALTER TABLE pr_review_findings ALTER COLUMN pr_review_id DROP NOT NULL;
ALTER TABLE pr_review_findings ADD COLUMN IF NOT EXISTS replay_id uuid;
ALTER TABLE pr_review_findings ADD COLUMN IF NOT EXISTS replay_pr_id uuid;
CREATE INDEX IF NOT EXISTS pr_review_findings_replay ON pr_review_findings (replay_id) WHERE replay_id IS NOT NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS review_precision_target numeric(3,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS review_effort_target_hours numeric(4,1);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS review_targets_replay_id uuid;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS review_targets_set_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS review_targets_set_by uuid;
