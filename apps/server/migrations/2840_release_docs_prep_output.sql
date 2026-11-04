-- Release prep (docs and videos): a content step's report per run, repository and step (shown on the Releases page).
ALTER TABLE release_docs_prep_steps ADD COLUMN IF NOT EXISTS output jsonb;
