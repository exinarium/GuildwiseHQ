-- Revision R3b (docs/ARCHITECTURE.md section 38.10): playbooks as `/` commands. Projection state, rebuilt from AgentPlaybookGranted.

-- An agent may start a playbook with `aom playbook run` only when it was granted that playbook. No row: not allowed (the default).
CREATE TABLE IF NOT EXISTS agent_playbook_grants (
  agent_id     uuid NOT NULL,
  org_id       uuid NOT NULL,
  playbook_key text NOT NULL,
  granted_by   uuid,
  granted_at   timestamptz NOT NULL,
  PRIMARY KEY (agent_id, playbook_key)
);
CREATE INDEX IF NOT EXISTS agent_playbook_grants_org ON agent_playbook_grants (org_id);
