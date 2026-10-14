-- Manual QA after Finalize (docs/design/manual-qa.md, backlog #64).

-- Per-project switch (default on, existing projects too): the person who started a card tests it before it is done.
ALTER TABLE projects ADD COLUMN manual_qa boolean NOT NULL DEFAULT true;

-- The card's QA state: assignee, source, steps, last decision, send-back count (projection of the Qa* events).
ALTER TABLE cards ADD COLUMN qa jsonb;

-- A person-completed workflow step, and a stage that falls back to another role when no agent of its own is hired.
ALTER TABLE workflow_stages ADD COLUMN fallback_role text;
ALTER TABLE workflow_stages DROP CONSTRAINT IF EXISTS workflow_stages_kind_check;
ALTER TABLE workflow_stages ADD CONSTRAINT workflow_stages_kind_check
  CHECK (kind IN ('agent','manual','terminal','subworkflow','human'));

-- A drafted ticket comment held until QA passes or is skipped (no desk item until it is released).
ALTER TABLE outbound_drafts DROP CONSTRAINT IF EXISTS outbound_drafts_status_check;
ALTER TABLE outbound_drafts ADD CONSTRAINT outbound_drafts_status_check
  CHECK (status IN ('pending','approved','rejected','posted','failed','blocked','held'));
CREATE INDEX outbound_drafts_held ON outbound_drafts (card_id) WHERE status = 'held';
