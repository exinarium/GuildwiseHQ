-- R3c, owner decision Q69: an agent-started playbook that would run on a workstation that is not the chat person's is asked of that
-- person first (pick one of their own workstations, or decline). Projection of PlaybookRunRequested / Decided / Started.
CREATE TABLE IF NOT EXISTS playbook_run_requests (
  request_id        uuid PRIMARY KEY,
  org_id            uuid NOT NULL,
  agent_id          uuid NOT NULL,
  chat_user_id      uuid NOT NULL,
  playbook_key      text NOT NULL,
  input             text NOT NULL DEFAULT '',
  chat_thread_id    uuid,
  desk_item_id      uuid NOT NULL,
  workstation_ids   uuid[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','started')),
  workstation_id    uuid,
  session_thread_id uuid,
  requested_at      timestamptz NOT NULL,
  decided_at        timestamptz
);
CREATE INDEX IF NOT EXISTS playbook_run_requests_agent ON playbook_run_requests (agent_id, requested_at);
CREATE INDEX IF NOT EXISTS playbook_run_requests_user ON playbook_run_requests (chat_user_id, status);
