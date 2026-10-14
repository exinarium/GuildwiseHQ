-- Run & test settings of a project (backlog #58, docs/design/run-and-integration-tests.md): free-text run instructions
-- for the project and per repository, plus the structured part (TTL, Docker opt-in, declared services). The
-- instructions go to the DevOps engineer when someone starts a branch. Projection columns of ProjectRunSettingsSet.
ALTER TABLE projects      ADD COLUMN run_instructions text  NOT NULL DEFAULT '';
ALTER TABLE projects      ADD COLUMN run_settings     jsonb NOT NULL DEFAULT '{}';
ALTER TABLE project_repos ADD COLUMN run_instructions text  NOT NULL DEFAULT '';
