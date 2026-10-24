-- R3c, owner decision Q66: an agent can opt out of a specific target its role grants it (a role's grant covers every agent of the
-- role; an exclusion is per agent). Projection of `DelegateExclusionChanged`; the events are the audit trail.
CREATE TABLE IF NOT EXISTS delegate_exclusions (
  agent_id     uuid NOT NULL,
  org_id       uuid NOT NULL,
  target_kind  text NOT NULL,
  target_key   text NOT NULL,
  excluded_by  uuid,
  excluded_at  timestamptz NOT NULL,
  PRIMARY KEY (agent_id, target_kind, target_key)
);
CREATE INDEX IF NOT EXISTS delegate_exclusions_org ON delegate_exclusions (org_id);
