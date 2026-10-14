-- "Draft with BA" for e-mail replies (#67 D): a person asks the BA for a draft, the BA task writes it here, the person
-- reviews it in the reply box and sends it (the send is the existing reply; nothing is sent by the draft).
-- Operational data (the task itself is event-sourced as a `mail_reply_draft` ba_task), no foreign keys.
CREATE TABLE mail_reply_drafts (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  thread_id    uuid NOT NULL,
  requested_by uuid NOT NULL,
  task_id      uuid,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','done','failed')),
  body_text    text,
  subject      text,
  error        text,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  used_at      timestamptz
);
CREATE INDEX mail_reply_drafts_thread ON mail_reply_drafts (thread_id, requested_by, created_at DESC);

ALTER TABLE ba_tasks DROP CONSTRAINT IF EXISTS ba_tasks_kind_check;
ALTER TABLE ba_tasks ADD CONSTRAINT ba_tasks_kind_check CHECK (kind IN
  ('phase_report','followups_brief','followup_custom','followups_report',
   'desk_triage','urgent_note','floor_alert','floor_report','scheduled_brief','batch_intake','mail_reply_draft'));
ALTER TABLE ba_tasks ADD COLUMN IF NOT EXISTS mail_draft_id uuid;
