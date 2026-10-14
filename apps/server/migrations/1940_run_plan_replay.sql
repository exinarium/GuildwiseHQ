-- Run plan replay (backlog #58, phase 2). A plan is replayed with no model call when it is `active` and its fingerprint
-- still matches. The fingerprint has two halves: BUILD.md (hashed by the runner from the run worktrees) and the run
-- instructions plus structured fields (hashed here). Plans saved before this migration have neither hash: they are not
-- replayed, the next DevOps run saves a new version that has them.
ALTER TABLE run_plans ADD COLUMN build_hash text;
ALTER TABLE run_plans ADD COLUMN settings_hash text;

-- Environments that started from a saved plan (no DevOps request at the start).
ALTER TABLE run_environments ADD COLUMN replayed boolean NOT NULL DEFAULT false;
