-- Release prep (docs and videos): what a step reports besides its files (for 'Update user guide': the sections it
-- changed or added, and the repositories it skipped). Null for the steps that report nothing.
ALTER TABLE release_docs_prep_steps ADD COLUMN IF NOT EXISTS output jsonb;
