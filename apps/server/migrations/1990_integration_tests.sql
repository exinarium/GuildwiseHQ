-- Integration tests of the tester (backlog #59, phase 3).

-- The project's Run & test integration setting (projection of ProjectIntegrationTestsSet). Every project starts `off`:
-- the owner switches it on (owner decision 2026-10-14). {"mode":"off"} is the schema default.
ALTER TABLE projects ADD COLUMN integration_tests jsonb NOT NULL DEFAULT '{"mode":"off"}';

-- A stage that runs against the project's running environment (`environment: 'project'`), read by the dispatcher.
ALTER TABLE workflow_stages ADD COLUMN environment text NOT NULL DEFAULT 'none' CHECK (environment IN ('none','project'));

-- A failed test environment is dealt with once (the card retries or stops): the server marks it here.
ALTER TABLE run_environments ADD COLUMN failure_handled boolean NOT NULL DEFAULT false;

-- When the tester gave its verdict (or the card left the stage): the environment is no longer the card's to use. A failed
-- card's environment is kept for inspection until expires_at.
ALTER TABLE run_environments ADD COLUMN verdict_at timestamptz;
