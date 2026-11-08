-- Release prep can start by itself when the release is ready on the test site.
ALTER TABLE release_docs_prep_runs DROP CONSTRAINT IF EXISTS release_docs_prep_runs_trigger_check;
ALTER TABLE release_docs_prep_runs ADD CONSTRAINT release_docs_prep_runs_trigger_check
  CHECK (trigger IN ('manual', 'retry', 'skip', 'auto'));
-- The release-branch head of each repository the run started on: {"<repoId>": "<sha>"}.
ALTER TABLE release_docs_prep_runs ADD COLUMN IF NOT EXISTS heads jsonb;
-- For an automatic run: the sorted "<repoId>@<sha>" list it started on. At most one automatic run per release and head.
ALTER TABLE release_docs_prep_runs ADD COLUMN IF NOT EXISTS ready_key text;
CREATE UNIQUE INDEX IF NOT EXISTS release_docs_prep_one_auto
  ON release_docs_prep_runs (project_id, release_branch, ready_key) WHERE trigger = 'auto';
