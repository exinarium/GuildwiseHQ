-- When project_repos.known_branches was last refreshed (a hygiene report or the origin branch list a shift start sends),
-- so the settings page does not claim a branch is missing from a list of unknown age.
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS known_branches_at timestamptz;
