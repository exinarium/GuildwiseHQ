-- The answer of a read-only runner command that a server-side caller waits for (`runner.diagnostics`, the CEO's
-- `aom ceo diag workstation`). Operational data like the rest of runner_commands: the caller clears it once read, and it is
-- never part of the event store.
ALTER TABLE runner_commands ADD COLUMN IF NOT EXISTS result jsonb;
