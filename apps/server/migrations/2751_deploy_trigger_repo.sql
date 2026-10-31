-- A merge only deploys its own repository (and bumps the submodule pin of a repository that contains it): the trigger
-- queue remembers which repository the newest merge landed in (repo_id) and every repository that merged during the
-- debounce window (repo_ids). Both are hints for the delivery pass; the commit to deploy is read from the events.
-- Rows queued before this migration have no repo: they behave as before.
ALTER TABLE deploy_trigger_queue ADD COLUMN IF NOT EXISTS repo_id  uuid;
ALTER TABLE deploy_trigger_queue ADD COLUMN IF NOT EXISTS repo_ids uuid[] NOT NULL DEFAULT '{}';
