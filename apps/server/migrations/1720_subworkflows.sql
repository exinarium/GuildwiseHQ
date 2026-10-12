-- Sub-workflows (docs/design/workflow-builder.md section 4). A `subworkflow` stage is run by the server: entering it
-- creates a child card (origin 'subworkflow', parent_card_id = the parent), and in wait mode the parent waits until the
-- child ends. The server never dispatches such a stage to an agent.

-- The new stage kind and the card origins of the workflow builder (sub-workflow, automation trigger, inbound e-mail).
ALTER TABLE workflow_stages DROP CONSTRAINT IF EXISTS workflow_stages_kind_check;
ALTER TABLE workflow_stages ADD CONSTRAINT workflow_stages_kind_check
  CHECK (kind IN ('agent','manual','terminal','subworkflow'));

ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_origin_check;
ALTER TABLE cards ADD CONSTRAINT cards_origin_check
  CHECK (origin IN ('manual','intake','schedule','test_failure','full_suite','regression','interest',
                    'subworkflow','trigger','email'));

-- One row per child started by a sub-workflow stage (projection of SubworkflowStarted / SubworkflowResolved).
-- (parent, stage, entry_seq) is the dedupe key: entry_seq is the event sequence of the move that brought the parent into
-- the stage, so a replayed event or a second pass of the reactor starts the stage once, and a later re-entry (rework,
-- a manager moving the card back) starts a new child.
CREATE TABLE subworkflow_runs (
  parent_card_id   uuid NOT NULL REFERENCES cards(id),
  stage_id         text NOT NULL,
  entry_seq        bigint NOT NULL,
  rework_round     integer NOT NULL DEFAULT 0,
  child_card_id    uuid NOT NULL REFERENCES cards(id),
  child_project_id uuid NOT NULL REFERENCES projects(id),
  workflow_key     text NOT NULL,
  workflow_version integer NOT NULL,
  mode             text NOT NULL CHECK (mode IN ('wait','continue')),
  -- open: the parent waits for the child. continued: the parent moved on at once. done / cancelled: the child ended.
  status           text NOT NULL CHECK (status IN ('open','continued','done','cancelled')),
  started_at       timestamptz NOT NULL,
  resolved_at      timestamptz,
  fields           jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (parent_card_id, stage_id, entry_seq),
  UNIQUE (child_card_id)
);
CREATE INDEX subworkflow_runs_open ON subworkflow_runs (child_card_id) WHERE status = 'open';
CREATE INDEX subworkflow_runs_parent ON subworkflow_runs (parent_card_id, started_at);

-- Where the sub-workflow reactor has read up to (operational: not a projection, kept across a rebuild). Created at the
-- current end of the log: no card can sit in a sub-workflow stage before this migration. (Absent later, the reactor reads
-- from the start; its handlers are idempotent.)
CREATE TABLE IF NOT EXISTS workflow_reactor_cursor (
  id       integer PRIMARY KEY CHECK (id = 1),
  last_seq bigint NOT NULL
);
INSERT INTO workflow_reactor_cursor (id, last_seq) SELECT 1, COALESCE(max(seq), 0) FROM events
  ON CONFLICT (id) DO NOTHING;
