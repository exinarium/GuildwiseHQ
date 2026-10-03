-- Outbound updates to company systems (M8). A draft is written by the BA (or the manager), approved, edited or
-- rejected on the decision desk, and only an approved draft is posted, by the card owner's workstation.
CREATE TABLE outbound_drafts (
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES users(id),
  project_id        uuid NOT NULL REFERENCES projects(id),
  card_id           uuid NOT NULL REFERENCES cards(id),
  external_system   text NOT NULL CHECK (external_system IN ('jira','github')),
  external_key      text NOT NULL,
  external_url      text,
  kind              text NOT NULL CHECK (kind IN ('comment','resolution','decision')),
  body              text NOT NULL,
  -- what was approved (the manager's edit, if any) and is posted exactly as it stands
  final_body        text,
  edited            boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','posted','failed','blocked')),
  desk_item_id      uuid,
  drafted_by_kind   text,
  drafted_by_id     uuid,
  approved_by       uuid REFERENCES users(id),
  reject_reason     text,
  blocked_matches   jsonb NOT NULL DEFAULT '[]',
  -- the URL or id the company system returned
  external_ref      text,
  error             text,
  attempts          int NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL,
  approved_at       timestamptz,
  posted_at         timestamptz,
  updated_at        timestamptz NOT NULL
);
CREATE INDEX outbound_drafts_card ON outbound_drafts (card_id, created_at DESC);
CREATE INDEX outbound_drafts_desk_item ON outbound_drafts (desk_item_id) WHERE desk_item_id IS NOT NULL;
-- approved drafts waiting for the owner's workstation (re-queued when one connects)
CREATE INDEX outbound_drafts_approved ON outbound_drafts (status) WHERE status = 'approved';
