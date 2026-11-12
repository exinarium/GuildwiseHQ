-- Owner-pending timers: a reminder after 2 working days without owner action (projection, rebuilt from the log).
CREATE TABLE IF NOT EXISTS owner_pending_timers (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL,
  project_id     uuid,
  card_id        uuid,
  kind           text NOT NULL,
  subject_id     text NOT NULL,
  owner_user_id  uuid NOT NULL,
  title          text NOT NULL,
  url            text,
  timezone       text NOT NULL,
  started_at     timestamptz NOT NULL,
  due_at         timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'open',
  reminded_at    timestamptz,
  desk_item_id   uuid,
  resolved_at    timestamptz,
  resolution     text,
  resolved_by    uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS owner_pending_open ON owner_pending_timers (kind, subject_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS owner_pending_due ON owner_pending_timers (due_at) WHERE status = 'open' AND reminded_at IS NULL;
