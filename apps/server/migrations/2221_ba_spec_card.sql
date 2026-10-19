-- `spec_card` BA tasks (docs/design/ceo-front-door.md section 2.4): the BA writes the missing fields of a draft card that
-- the CEO sent on, so the card can be specified.
ALTER TABLE ba_tasks DROP CONSTRAINT IF EXISTS ba_tasks_kind_check;
ALTER TABLE ba_tasks ADD CONSTRAINT ba_tasks_kind_check CHECK (kind IN
  ('phase_report','followups_brief','followup_custom','followups_report',
   'desk_triage','urgent_note','floor_alert','floor_report','scheduled_brief','batch_intake','mail_reply_draft',
   'spec_card'));
ALTER TABLE ba_tasks ADD COLUMN IF NOT EXISTS card_id uuid;
CREATE INDEX IF NOT EXISTS ba_tasks_card ON ba_tasks (card_id) WHERE card_id IS NOT NULL;
