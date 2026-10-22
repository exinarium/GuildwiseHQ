-- Capability Registry v0: what a runner indexed in the organization vault (`org/skills`, `org/personas`, `org/playbooks`).
-- Metadata only (the server never stores vault content). Projection table rebuilt from `CapabilityIndexReported`.
CREATE TABLE IF NOT EXISTS capability_index (
  org_id       uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('skill','persona','playbook')),
  key          text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  hash         text NOT NULL,
  source       text NOT NULL DEFAULT 'org-vault',
  vault_id     uuid NOT NULL,
  reported_at  timestamptz NOT NULL,
  PRIMARY KEY (org_id, kind, key)
);

-- One row per organization: when the index was last reported, from where, and the files that did not parse.
CREATE TABLE IF NOT EXISTS capability_index_status (
  org_id         uuid PRIMARY KEY,
  vault_id       uuid NOT NULL,
  workstation_id uuid NOT NULL,
  issues         jsonb NOT NULL DEFAULT '[]',
  item_hash      text NOT NULL,                 -- digest of the reported set: an identical report appends no event
  reported_at    timestamptz NOT NULL
);
