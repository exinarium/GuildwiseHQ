-- 1.10.0 (deps-without-sudo): the sudo password and the sudo grant for the DevOps engineer are removed. The runner keeps
-- no sealed sudo password and has no root path; the installer does all root work once.
-- 1. Forget every queued sudo ciphertext, whatever the command's status (a completed row is normally emptied by the old
--    result handler, but rows that ended otherwise, or predate it, can still hold one), then fail what is still queued.
-- 2. Drop the stored facts about a sudo password (never the password itself; the server never had it).
-- 3. Drop the `sudo` flag from the stored DevOps access (the DevOpsAccess schema defaults it to false).
-- Idempotent: running it again changes nothing.
UPDATE runner_commands SET payload = '{}'::jsonb
  WHERE type IN ('sudo.set', 'sudo.clear') AND payload <> '{}'::jsonb;
UPDATE runner_commands SET status = 'failed', last_error = 'sudo was removed in 1.10.0'
  WHERE type IN ('sudo.set', 'sudo.clear') AND status IN ('pending', 'sent');
UPDATE workstations SET devops_sudo_set_at = NULL, devops_sudo_works = NULL, devops_sudo_key_id = NULL
  WHERE devops_sudo_set_at IS NOT NULL OR devops_sudo_works IS NOT NULL OR devops_sudo_key_id IS NOT NULL;
UPDATE workstations SET devops_access = devops_access - 'sudo' WHERE devops_access ? 'sudo';
