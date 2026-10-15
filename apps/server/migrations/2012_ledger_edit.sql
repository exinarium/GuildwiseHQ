-- Editing a standing order in place (backlog #74): the ledger row carries the current wording and a version counter,
-- the previous wordings are kept in ledger_entry_versions so the history stays visible. Projection of LedgerEntryEdited.
ALTER TABLE ledger_entries
  ADD COLUMN version        integer NOT NULL DEFAULT 1,
  ADD COLUMN edited_at      timestamptz,
  ADD COLUMN edited_by_kind text,
  ADD COLUMN edited_by_id   uuid;

CREATE TABLE ledger_entry_versions (
  entry_id      uuid NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL,
  tags          text[] NOT NULL DEFAULT '{}',
  saved_by_kind text NOT NULL,
  saved_by_id   uuid,
  saved_at      timestamptz NOT NULL,   -- when this wording came into force
  replaced_at   timestamptz NOT NULL,
  PRIMARY KEY (entry_id, version)
);
