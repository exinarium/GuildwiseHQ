-- "Post as" app selection per project (references only; never a key or a token).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS post_as jsonb;          -- projection of ProjectPostAsAppsSet (NULL = none)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS post_as_set_by uuid;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS post_as_set_at timestamptz;

-- Runner fact (like workstation_repos.git_identity): can the app's installation reach the repository?
CREATE TABLE IF NOT EXISTS project_app_access (
  project_id uuid NOT NULL,
  repo_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  state text NOT NULL,                                                  -- covered | not_covered | error
  code text,
  detail text,
  checked_at timestamptz NOT NULL,
  workstation_id uuid,
  PRIMARY KEY (project_id, repo_id, integration_id)
);
