-- "Commit as" (backlog #65, invisible organisation): the name and e-mail every commit of a project carries. A project
-- setting (projection of ProjectCommitAsSet, {name,email} or NULL), not a secret. The git identity a workstation reports per
-- clone (repository, global or system git config) is a fact of the runner's repo report, kept next to the clone match.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS commit_as jsonb;
ALTER TABLE workstation_repos ADD COLUMN IF NOT EXISTS git_identity jsonb;
