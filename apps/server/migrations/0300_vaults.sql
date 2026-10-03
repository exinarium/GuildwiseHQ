-- M3: knowledge vaults. The site stores the git URL only, never vault content.
CREATE TABLE vaults (
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES users(id),
  project_id        uuid REFERENCES projects(id),           -- set for a shared project's vault
  kind              text NOT NULL CHECK (kind IN ('work','personal','project')),
  name              text NOT NULL,
  remote_url        text NOT NULL,
  sync_interval_sec integer NOT NULL DEFAULT 300 CHECK (sync_interval_sec BETWEEN 1 AND 86400),
  created_at        timestamptz NOT NULL,
  CHECK ((kind = 'project') = (project_id IS NOT NULL))
);
-- One work and one personal vault per user; one vault per project.
CREATE UNIQUE INDEX vaults_one_per_org_kind ON vaults (org_id, kind) WHERE project_id IS NULL;
CREATE UNIQUE INDEX vaults_one_per_project ON vaults (project_id) WHERE project_id IS NOT NULL;

-- Operational (reported by runners with hello / vault.status / vault.conflict); not rebuilt from events.
CREATE TABLE workstation_vaults (
  workstation_id uuid NOT NULL REFERENCES workstations(id),
  vault_id       uuid NOT NULL REFERENCES vaults(id),
  local_path     text,
  last_pull_at   timestamptz,
  last_push_at   timestamptz,
  last_error     text,
  paused         boolean NOT NULL DEFAULT false,            -- sync paused after an unresolved conflict
  conflict_files text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (workstation_id, vault_id)
);
CREATE INDEX workstation_vaults_vault ON workstation_vaults (vault_id);
