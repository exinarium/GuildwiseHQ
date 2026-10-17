-- Retiring a ledger entry (Lean Team v3, stream S1b). A retired entry is kept for the record but is never injected into
-- a prompt and never found by a search. Projection of LedgerEntryRetired; `conflicts_with` is the projection of
-- LedgerEntryFlagged (a saved standing order that may contradict a live one).
ALTER TABLE ledger_entries
  ADD COLUMN retired_at      timestamptz,
  ADD COLUMN retired_reason  text,
  ADD COLUMN retired_by      text,
  ADD COLUMN conflicts_with  uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX ledger_entries_live ON ledger_entries (org_id, scope) WHERE retired_at IS NULL AND superseded_by IS NULL;
