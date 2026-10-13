-- Project setting "Remove finished card branches": repository hygiene deletes the branches of done or cancelled cards
-- (origin, clone and worktree) once their work is merged, migrated or its pull request is closed. Default on.
ALTER TABLE projects ADD COLUMN remove_finished_branches boolean NOT NULL DEFAULT true;
