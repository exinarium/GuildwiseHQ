-- Owner marks (useful/noise) on posted PR review findings. Projection of PrReviewFindingMarked. No foreign keys.
CREATE TABLE IF NOT EXISTS pr_review_finding_marks (
  finding_id      uuid PRIMARY KEY,
  pr_review_id    uuid NOT NULL,
  run_id          uuid NOT NULL,
  project_id      uuid NOT NULL,
  mark            text NOT NULL CHECK (mark IN ('useful','noise')),
  blind_mark      text NOT NULL CHECK (blind_mark IN ('useful','noise')),
  marked_by       uuid NOT NULL,
  marked_at       timestamptz NOT NULL,
  first_marked_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pr_review_finding_marks_project ON pr_review_finding_marks (project_id, marked_at);
CREATE INDEX IF NOT EXISTS pr_review_finding_marks_pr ON pr_review_finding_marks (pr_review_id);

-- Who produced a finding: the reviewer of its run. The finding, precision and replay queries read only this view.
CREATE OR REPLACE VIEW pr_review_finding_attribution AS
  SELECT f.id AS finding_id, run.reviewer, run.model, run.runtime
    FROM pr_review_findings f JOIN pr_review_runs run ON run.id = f.run_id;
