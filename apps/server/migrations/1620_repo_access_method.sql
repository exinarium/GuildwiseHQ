-- How git reaches a project repository: 'ssh' (a key on the workstation) or 'https' (API token / CLI login).
-- NULL: the workstation default of the git host applies. Projection of ProjectRepoAdded.accessMethod /
-- ProjectRepoAccessSet; rebuilt from events.
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS access_method text
  CHECK (access_method IS NULL OR access_method IN ('https','ssh'));
