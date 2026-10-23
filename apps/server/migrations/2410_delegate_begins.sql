-- `aom delegate`, review fix: the server records when a delegate begins (not only when its cost arrives), so parallel calls of
-- one caller count against the per-caller cap and against a session or project budget while they are still running.
-- Operational state (like runner_commands): not a projection, a row goes when the delegate's cost is booked or when it is stale.
CREATE TABLE IF NOT EXISTS delegate_begins (
  delegate_id  uuid PRIMARY KEY,
  caller_id    uuid NOT NULL,
  org_id       uuid NOT NULL,
  thread_id    uuid,
  project_id   uuid,
  begun_at     timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS delegate_begins_caller ON delegate_begins (caller_id);
CREATE INDEX IF NOT EXISTS delegate_begins_thread ON delegate_begins (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS delegate_begins_project ON delegate_begins (project_id) WHERE project_id IS NOT NULL;
