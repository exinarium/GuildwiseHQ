-- Automations: event triggers that create cards (docs/design/workflow-builder.md section 5).
-- `dedupe_key` is the content key of a run that created a card (`create_card.dedupe`): a later run with the same key
-- creates no second card. Operational lookup only; the history of runs is unchanged.
-- Guarded: the migration tests replay the files with 1314 (which creates `schedule_runs`) left out and applied last.
DO $$
BEGIN
  IF to_regclass('schedule_runs') IS NOT NULL THEN
    ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS dedupe_key text;
    CREATE INDEX IF NOT EXISTS schedule_runs_dedupe ON schedule_runs (schedule_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
  END IF;
END $$;
