-- Release prep 'Write changelog': a `release_changelog` BA task proposes the public changelog entries for one repository
-- of a prep run. The task names the run and the repository.
ALTER TABLE ba_tasks DROP CONSTRAINT IF EXISTS ba_tasks_kind_check;
ALTER TABLE ba_tasks ADD CONSTRAINT ba_tasks_kind_check CHECK (kind IN
  ('phase_report','followups_brief','followup_custom','followups_report',
   'desk_triage','urgent_note','floor_alert','floor_report','scheduled_brief','batch_intake','mail_reply_draft',
   'spec_card','release_changelog'));
ALTER TABLE ba_tasks ADD COLUMN IF NOT EXISTS prep_run_id uuid;
ALTER TABLE ba_tasks ADD COLUMN IF NOT EXISTS prep_repo_id uuid;
CREATE INDEX IF NOT EXISTS ba_tasks_prep_run ON ba_tasks (prep_run_id) WHERE prep_run_id IS NOT NULL;
