-- S-B1 Governance: per-agent approval gates (projection of AgentGateSet / GatedAction*) and one-tap notification tokens
-- (operational, not event-sourced: a token is short-lived, single-use and bound to a user, an item and an action).

CREATE TABLE IF NOT EXISTS agent_action_gates (
  agent_id     uuid NOT NULL,
  org_id       uuid NOT NULL,
  action_class text NOT NULL,
  set_by       uuid,
  set_at       timestamptz NOT NULL,
  PRIMARY KEY (agent_id, action_class)
);
CREATE INDEX IF NOT EXISTS agent_action_gates_org ON agent_action_gates (org_id);

-- A gated action that paused: the desk item that asks, and the approval the agent's retry uses once.
CREATE TABLE IF NOT EXISTS gated_actions (
  request_id   uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  agent_id     uuid NOT NULL,
  action_class text NOT NULL,
  fingerprint  text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  desk_item_id uuid NOT NULL,
  project_id   uuid,
  card_id      uuid,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','used')),
  requested_at timestamptz NOT NULL,
  decided_by   uuid,
  decided_at   timestamptz,
  used_at      timestamptz
);
CREATE INDEX IF NOT EXISTS gated_actions_agent ON gated_actions (agent_id, action_class, fingerprint);
CREATE INDEX IF NOT EXISTS gated_actions_desk ON gated_actions (desk_item_id);

CREATE TABLE IF NOT EXISTS desk_action_tokens (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  user_id      uuid NOT NULL,
  desk_item_id uuid NOT NULL,
  action       text NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);
CREATE INDEX IF NOT EXISTS desk_action_tokens_expiry ON desk_action_tokens (expires_at);
CREATE INDEX IF NOT EXISTS desk_action_tokens_user ON desk_action_tokens (user_id);
