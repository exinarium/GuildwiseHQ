-- BA intake and the escalation chain (M7).
-- An intake is one chat with the BA about a ticket (the thread has kind 'intake'); it maps to a project and links the
-- cards the BA drafted. Questions travel peer -> BA -> desk: the trail is kept on the desk item.
CREATE TABLE intakes (
  id                   uuid PRIMARY KEY,
  org_id               uuid NOT NULL REFERENCES users(id),
  thread_id            uuid NOT NULL,
  external_system      text CHECK (external_system IN ('jira','github')),
  external_key         text,
  note                 text,
  started_by           uuid NOT NULL REFERENCES users(id),
  ba_agent_id          uuid NOT NULL REFERENCES agents(id),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','mapped','unmapped')),
  mapped_project_id    uuid REFERENCES projects(id),
  mapping_desk_item_id uuid,
  created_at           timestamptz NOT NULL
);
CREATE UNIQUE INDEX intakes_thread ON intakes (thread_id);
CREATE INDEX intakes_org ON intakes (org_id, created_at DESC);
CREATE INDEX intakes_mapping_item ON intakes (mapping_desk_item_id) WHERE mapping_desk_item_id IS NOT NULL;

CREATE TABLE intake_cards (
  intake_id  uuid NOT NULL REFERENCES intakes(id),
  card_id    uuid NOT NULL REFERENCES cards(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (intake_id, card_id)
);
CREATE INDEX intake_cards_card ON intake_cards (card_id);

-- Who looked at a question on its way to the desk, and who answered it (an agent, or the manager).
ALTER TABLE desk_items
  ADD COLUMN escalation_trail jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN answered_by_agent_id uuid REFERENCES agents(id);
-- The agent queue: open questions routed to an agent.
CREATE INDEX desk_items_agent_queue ON desk_items (routed_agent_id, created_at) WHERE status = 'open' AND routed_to = 'agent';

-- A `question` shift answers one desk item.
ALTER TABLE shifts ADD COLUMN desk_item_id uuid;
CREATE INDEX shifts_desk_item ON shifts (desk_item_id) WHERE desk_item_id IS NOT NULL;
