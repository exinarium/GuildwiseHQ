-- A failed run environment stays visible (state, reason, a link to the DevOps request) until the owner dismisses it.
ALTER TABLE run_environments ADD COLUMN dismissed_at timestamptz;
