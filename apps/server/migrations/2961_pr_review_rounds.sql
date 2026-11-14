-- Review rounds: one posting unit per PR review, of one or two reviewer runs. Projections; no foreign keys.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pr_review_second_reviewer boolean NOT NULL DEFAULT false;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS reviewed_by_all text[];

CREATE TABLE IF NOT EXISTS pr_review_rounds (
  id uuid PRIMARY KEY,
  pr_review_id uuid NOT NULL,
  project_id uuid NOT NULL,
  reviewers text[] NOT NULL,
  trigger text NOT NULL DEFAULT 'auto',
  requested_by uuid,
  workstation_id uuid,
  state text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  changed_lines integer,
  findings_cap integer,
  held_back_count integer NOT NULL DEFAULT 0,
  merged_count integer NOT NULL DEFAULT 0,
  end_code text,
  cause_run_id uuid,
  review_url text,
  posted_at timestamptz,
  posting_at timestamptz,
  rerun_of_round_id uuid
);
CREATE INDEX IF NOT EXISTS pr_review_rounds_pr ON pr_review_rounds (pr_review_id, started_at DESC);
CREATE INDEX IF NOT EXISTS pr_review_rounds_active ON pr_review_rounds (state) WHERE state IN ('running', 'posting');

ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS round_id uuid;
CREATE INDEX IF NOT EXISTS pr_review_runs_round ON pr_review_runs (round_id);
ALTER TABLE pr_review_findings ADD COLUMN IF NOT EXISTS merged_into uuid;

-- disposition gains 'merged'
ALTER TABLE pr_review_findings DROP CONSTRAINT IF EXISTS pr_review_findings_disposition_check;
ALTER TABLE pr_review_findings ADD CONSTRAINT pr_review_findings_disposition_check
  CHECK (disposition IN ('posted', 'held_back', 'merged'));

-- Backfill: every live run recorded before rounds is a round of one with the run's id.
INSERT INTO pr_review_rounds (id, pr_review_id, project_id, reviewers, trigger, requested_by, workstation_id, state,
                              started_at, finished_at, changed_lines, findings_cap, held_back_count, end_code,
                              review_url, posted_at, posting_at, rerun_of_round_id)
SELECT r.id, r.pr_review_id, r.project_id, ARRAY[r.reviewer], r.trigger, r.requested_by, r.workstation_id,
       CASE r.state WHEN 'completed' THEN 'posting' ELSE r.state END,
       r.started_at, r.finished_at, r.changed_lines, r.findings_cap, r.held_back_count, r.error_code,
       r.review_url, r.posted_at, CASE r.state WHEN 'completed' THEN r.finished_at END, r.rerun_of_run_id
  FROM pr_review_runs r
 WHERE r.replay_id IS NULL AND r.round_id IS NULL
ON CONFLICT (id) DO NOTHING;
UPDATE pr_review_runs SET round_id = id WHERE replay_id IS NULL AND round_id IS NULL;
UPDATE pr_reviews SET reviewed_by_all = ARRAY[reviewed_by] WHERE reviewed_by IS NOT NULL AND reviewed_by_all IS NULL;

-- Attribution, with the SAME columns as before: a canonical finding is credited to its own run's reviewer and to the
-- reviewer of every duplicate merged into it.
CREATE OR REPLACE VIEW pr_review_finding_attribution AS
  SELECT f.id AS finding_id, run.reviewer, run.model, run.runtime
    FROM pr_review_findings f JOIN pr_review_runs run ON run.id = f.run_id
   WHERE f.disposition <> 'merged'
  UNION
  SELECT d.merged_into AS finding_id, run.reviewer, run.model, run.runtime
    FROM pr_review_findings d JOIN pr_review_runs run ON run.id = d.run_id
   WHERE d.disposition = 'merged' AND d.merged_into IS NOT NULL;
