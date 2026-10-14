-- Batch intake (#63): the owner hands the BA a list of tickets; one item and one BA task (kind 'batch_intake') per ticket.
CREATE TABLE intake_batches (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES users(id),
  created_by   uuid NOT NULL REFERENCES users(id),
  project_id   uuid,
  note         text,
  cancelled_at timestamptz,
  created_at   timestamptz NOT NULL
);
CREATE INDEX intake_batches_org ON intake_batches (org_id, created_at DESC);

CREATE TABLE intake_batch_items (
  id               uuid PRIMARY KEY,
  batch_id         uuid NOT NULL REFERENCES intake_batches(id) ON DELETE CASCADE,
  position         integer NOT NULL,
  external_system  text NOT NULL CHECK (external_system IN ('jira','github')),
  external_key     text NOT NULL,
  url              text,
  status           text NOT NULL CHECK (status IN ('queued','reading','waiting','done','skipped','failed','cancelled')),
  task_id          uuid,
  intake_id        uuid,
  desk_item_id     uuid,
  question         text,
  qa               jsonb NOT NULL DEFAULT '[]',
  card_refs        text[] NOT NULL DEFAULT '{}',
  summary          text,
  reason           text,
  attempts         integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
CREATE INDEX intake_batch_items_batch ON intake_batch_items (batch_id, position);
CREATE INDEX intake_batch_items_task ON intake_batch_items (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX intake_batch_items_desk ON intake_batch_items (desk_item_id) WHERE desk_item_id IS NOT NULL;

ALTER TABLE ba_tasks DROP CONSTRAINT IF EXISTS ba_tasks_kind_check;
ALTER TABLE ba_tasks ADD CONSTRAINT ba_tasks_kind_check CHECK (kind IN
  ('phase_report','followups_brief','followup_custom','followups_report',
   'desk_triage','urgent_note','floor_alert','floor_report','scheduled_brief','batch_intake'));
ALTER TABLE ba_tasks ADD COLUMN IF NOT EXISTS batch_id      uuid;
ALTER TABLE ba_tasks ADD COLUMN IF NOT EXISTS batch_item_id uuid;
CREATE INDEX IF NOT EXISTS ba_tasks_batch ON ba_tasks (batch_id) WHERE batch_id IS NOT NULL;
