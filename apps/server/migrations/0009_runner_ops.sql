CREATE TABLE runner_commands (                  -- durable server->runner commands for offline delivery
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workstation_id uuid NOT NULL REFERENCES workstations(id),
  type           text NOT NULL,                 -- agent.wipe | worktree.remove | vault.write | vault.configure | finalize.execute | repos.rescan
  payload        jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','done','failed')),
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz, done_at timestamptz
);
CREATE INDEX runner_commands_pending ON runner_commands (workstation_id, created_at) WHERE status IN ('pending','sent');

CREATE TABLE runner_inbox (                     -- idempotency for runner->server acked messages
  message_id     uuid PRIMARY KEY,
  workstation_id uuid NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  result         jsonb                          -- reply to re-send when a duplicate arrives (shift.report.result)
);
