-- Requirements ledger (M2): feature requirements, project decision log and standing orders, searchable.
CREATE TABLE ledger_entries (
  id                    uuid PRIMARY KEY,
  org_id                uuid NOT NULL REFERENCES users(id),
  project_id            uuid REFERENCES projects(id),           -- NULL: org-wide (standing orders)
  card_id               uuid REFERENCES cards(id),
  scope                 text NOT NULL CHECK (scope IN ('feature','decision','standing_order')),
  title                 text NOT NULL,
  body                  text NOT NULL,
  tags                  text[] NOT NULL DEFAULT '{}',
  source_desk_item_id   uuid REFERENCES desk_items(id),
  vault_path            text,
  created_by_kind       text NOT NULL,
  created_by_id         uuid,
  superseded_by         uuid REFERENCES ledger_entries(id),
  created_at            timestamptz NOT NULL,
  search                tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED
);
CREATE INDEX ledger_entries_search ON ledger_entries USING GIN (search);
CREATE INDEX ledger_entries_org ON ledger_entries (org_id, scope, created_at DESC) WHERE superseded_by IS NULL;
CREATE INDEX ledger_entries_project ON ledger_entries (project_id) WHERE superseded_by IS NULL;
CREATE INDEX ledger_entries_card ON ledger_entries (card_id) WHERE card_id IS NOT NULL;
