-- Part B (docs/design/phases.md): the BA as the manager's reporter.

-- The manager's time zone (browser-detected on first login, editable), the organization's reporting preferences
-- (`routeViaBa`, `dailyAt`; absent keys mean the defaults: routing on, 08:00), the standing "BA reports" chat and the
-- local date of the last floor report that was queued.
ALTER TABLE users
  ADD COLUMN timezone          text,
  ADD COLUMN reporting         jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN ba_chat_thread_id uuid,
  ADD COLUMN floor_report_day  text;

-- Desk routing: items can be held for the BA's triage until `triage_deadline`, then reach the manager unchanged.
-- `status` stays 'open' while held; the desk list hides `triage = 'pending'`.
ALTER TABLE desk_items
  ADD COLUMN ba_note         text,
  ADD COLUMN ba_note_at      timestamptz,
  ADD COLUMN superseded_by   uuid,
  ADD COLUMN triage          text NOT NULL DEFAULT 'none'
                             CHECK (triage IN ('none','pending','passed','released','dismissed','merged')),
  ADD COLUMN triage_deadline timestamptz,
  ADD COLUMN data            jsonb,
  ADD COLUMN chat_thread_id  uuid;
CREATE INDEX desk_items_triage ON desk_items (triage_deadline) WHERE triage = 'pending';

ALTER TABLE ba_tasks DROP CONSTRAINT ba_tasks_kind_check;
ALTER TABLE ba_tasks ADD CONSTRAINT ba_tasks_kind_check CHECK (kind IN
  ('phase_report','followups_brief','followup_custom','followups_report',
   'desk_triage','urgent_note','floor_alert','floor_report'));
ALTER TABLE ba_tasks
  ADD COLUMN signal_ids    uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN desk_item_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN local_date    text;

-- Deterministic detectors (reporter/detectors.ts): one open signal per fingerprint.
CREATE TABLE ba_signals (
  id                   uuid PRIMARY KEY,
  org_id               uuid NOT NULL REFERENCES users(id),
  project_id           uuid,
  kind                 text NOT NULL,
  fingerprint          text NOT NULL,
  urgency              text NOT NULL CHECK (urgency IN ('urgent','normal')),
  subject              jsonb NOT NULL,
  evidence             jsonb NOT NULL DEFAULT '{}',
  count                integer NOT NULL DEFAULT 1,
  status               text NOT NULL CHECK (status IN ('open','reported','resolved')),
  report_desk_item_id  uuid,
  first_seen_at        timestamptz NOT NULL,
  last_seen_at         timestamptz NOT NULL,
  reported_at          timestamptz,
  resolved_at          timestamptz
);
CREATE UNIQUE INDEX ba_signals_open_fingerprint ON ba_signals (org_id, fingerprint) WHERE status <> 'resolved';
CREATE INDEX ba_signals_org ON ba_signals (org_id, status);
