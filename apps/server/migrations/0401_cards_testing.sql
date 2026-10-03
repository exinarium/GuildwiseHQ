-- M4: card columns for the test environment park and the finalize state (projections of the testing events).
ALTER TABLE cards
  ADD COLUMN parked_request_id    uuid,                 -- tester shift parked on this DevOps request
  ADD COLUMN park_problem         text,
  ADD COLUMN env_parks            integer NOT NULL DEFAULT 0,
  ADD COLUMN finalize_action      text CHECK (finalize_action IN ('pr','push_branch','merge')),
  ADD COLUMN finalize_state       text CHECK (finalize_state IN ('awaiting_approval','running','failed')),
  ADD COLUMN finalize_desk_item_id uuid,
  ADD COLUMN finalize_error       text,
  ADD COLUMN finalize_result      jsonb;
CREATE INDEX cards_parked ON cards (parked_request_id) WHERE parked_request_id IS NOT NULL;
CREATE INDEX cards_parent ON cards (parent_card_id) WHERE parent_card_id IS NOT NULL;
