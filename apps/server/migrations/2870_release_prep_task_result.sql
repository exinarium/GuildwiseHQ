-- Release prep tasks: the checked proposal of a proposal task (changelog entries, guide edits) and, for a task that
-- failed because no agent could write it, the failure code. DDL only; nothing to backfill.
ALTER TABLE release_docs_prep_tasks ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE release_docs_prep_tasks ADD COLUMN IF NOT EXISTS code text;
