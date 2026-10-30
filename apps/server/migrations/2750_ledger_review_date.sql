-- Review dates on ledger entries (release 1.4.0). Optional calendar date; existing entries keep NULL and behave as
-- before. reviewed_at is set when the owner confirms a due entry. Projection of LedgerEntryAdded.reviewDate and
-- LedgerEntryReviewDateSet. Safe to run again.
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS review_date date,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
CREATE INDEX IF NOT EXISTS ledger_entries_review_due ON ledger_entries (org_id, review_date)
  WHERE review_date IS NOT NULL AND retired_at IS NULL AND superseded_by IS NULL;
