-- Decision desk (M2): everything that needs the manager, plus the blockers it puts on cards.
CREATE TABLE desk_items (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES users(id),
  project_id          uuid REFERENCES projects(id),
  card_id             uuid REFERENCES cards(id),
  kind                text NOT NULL CHECK (kind IN ('question','approval','escalation','alert','rating')),
  subkind             text,                                   -- outbound | large_merge | devops | taste_rule | tester_bottleneck | vault_conflict | ...
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed','superseded')),
  routed_to           text NOT NULL DEFAULT 'manager' CHECK (routed_to IN ('manager','agent')),
  routed_agent_id     uuid REFERENCES agents(id),
  title               text NOT NULL,
  body                text NOT NULL DEFAULT '',
  doing               text NOT NULL DEFAULT '',               -- what the asker was doing
  options             jsonb NOT NULL DEFAULT '[]',            -- [{id,label,description?}]
  recommendation      text,                                   -- option id
  blocking            boolean NOT NULL DEFAULT false,
  affected_card_ids   uuid[] NOT NULL DEFAULT '{}',
  asked_by_kind       text NOT NULL DEFAULT 'system' CHECK (asked_by_kind IN ('agent','user','system')),
  asked_by_agent_id   uuid REFERENCES agents(id),
  asked_by_user_id    uuid REFERENCES users(id),
  asked_by_role       text,
  shift_id            uuid,                                   -- shift that raised the question
  pinned              boolean NOT NULL DEFAULT false,
  dedup_ledger_ids    uuid[] NOT NULL DEFAULT '{}',
  answer              text,
  answer_option       text,
  answered_by         uuid REFERENCES users(id),
  answered_at         timestamptz,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);
-- GET /api/desk order: pinned DESC, blocking DESC, cardinality(affected_card_ids) DESC, created_at ASC.
CREATE INDEX desk_items_open ON desk_items (org_id, pinned DESC, blocking DESC, created_at) WHERE status = 'open';
CREATE INDEX desk_items_project ON desk_items (project_id, status);
CREATE INDEX desk_items_card ON desk_items (card_id) WHERE card_id IS NOT NULL;
CREATE INDEX desk_items_shift ON desk_items (shift_id) WHERE shift_id IS NOT NULL;

CREATE TABLE card_blockers (
  card_id       uuid NOT NULL REFERENCES cards(id),
  desk_item_id  uuid NOT NULL REFERENCES desk_items(id),
  PRIMARY KEY (card_id, desk_item_id)
);
CREATE INDEX card_blockers_item ON card_blockers (desk_item_id);
