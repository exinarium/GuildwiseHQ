-- Release prep closed by the system (2026-11-16): a run still running when its release ships is skipped with a reason
-- the manager sees; skipped_by stays NULL for such a run.
ALTER TABLE release_docs_prep_runs ADD COLUMN IF NOT EXISTS skip_reason text;
