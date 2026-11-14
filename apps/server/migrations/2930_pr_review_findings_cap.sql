-- Findings cap: one finding per 100 changed lines (1..5), the rest held back (stored, never posted).
ALTER TABLE pr_review_findings ADD COLUMN IF NOT EXISTS rank integer;
ALTER TABLE pr_review_findings ADD COLUMN IF NOT EXISTS disposition text NOT NULL DEFAULT 'posted'
  CHECK (disposition IN ('posted','held_back'));
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS changed_lines integer;
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS findings_cap integer;
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS held_back_count integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS pr_review_findings_disposition ON pr_review_findings (run_id, disposition, rank);
