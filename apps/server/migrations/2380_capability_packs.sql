-- Capability packs (docs/ARCHITECTURE.md section 38.4): git repositories imported into the capability registry, pinned to a commit
-- and approved by the owner. Metadata only: the files stay on the workstations. Projection tables rebuilt from the Pack* events.
CREATE TABLE IF NOT EXISTS packs (
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL,
  name              text NOT NULL,                 -- the namespace: keys are '<name>:<key>'
  url               text NOT NULL,
  ref               text NOT NULL,
  adapter           text NOT NULL DEFAULT 'auto',
  scope             text NOT NULL DEFAULT 'org' CHECK (scope IN ('org','project')),
  project_id        uuid,
  preset            text,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
  error             text,
  pinned_sha        text,
  content_hash      text,                          -- of the pinned snapshot
  snapshot          jsonb,                         -- what a workstation saw at the pin: items with files, issues, notes
  has_scripts       boolean NOT NULL DEFAULT false,
  license           text,
  trusted           boolean NOT NULL DEFAULT false,
  trusted_sha       text,
  trusted_hash      text,
  trusted_by        uuid,
  trusted_at        timestamptz,
  scripts_enabled   boolean NOT NULL DEFAULT false,
  integrity_failed  boolean NOT NULL DEFAULT false,
  update_snapshot   jsonb,                         -- a newer commit on offer (never applied without PackUpdateAccepted)
  update_diff       jsonb,
  update_found_at   timestamptz,
  last_checked_at   timestamptz,
  added_by          uuid,
  added_at          timestamptz NOT NULL,
  removed_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS packs_org_name ON packs (org_id, name) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS packs_org ON packs (org_id) WHERE removed_at IS NULL;

-- What a runner found in a project's checkout (.agents/skills, .claude/skills, .claude/agents): metadata only.
CREATE TABLE IF NOT EXISTS project_capability_index (
  org_id       uuid NOT NULL,
  project_id   uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('skill','persona','playbook')),
  key          text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  hash         text NOT NULL,
  icon         text,
  reported_at  timestamptz NOT NULL,
  PRIMARY KEY (project_id, kind, key)
);
CREATE TABLE IF NOT EXISTS project_capability_status (
  project_id   uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  issues       jsonb NOT NULL DEFAULT '[]',
  reported_at  timestamptz NOT NULL
);
