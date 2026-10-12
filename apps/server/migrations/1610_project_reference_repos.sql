-- Reference repositories of a project: ids of project_repos (of other projects of the organization) whose code the
-- project's agents may read, read-only. Projection of ProjectReferenceReposSet; rebuilt from events.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS reference_repo_ids uuid[] NOT NULL DEFAULT '{}';
