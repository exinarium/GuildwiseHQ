-- The sub directory of a project repository the project lives in (monorepo, `src/app`); NULL: the repository root.
-- Projection of ProjectRepoAdded.projectPath / ProjectRepoPathSet; rebuilt from events.
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS project_path text;
