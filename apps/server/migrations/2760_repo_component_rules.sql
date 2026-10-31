-- Component version rules of a repository (name, path globs, version file, pattern); empty: none.
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS component_rules jsonb NOT NULL DEFAULT '[]'::jsonb;
