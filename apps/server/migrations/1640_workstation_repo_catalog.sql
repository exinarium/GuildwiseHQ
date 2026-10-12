-- Every repository found on a workstation under its repoRoots (with or without a remote), as reported by the runner in
-- hello / repos.report (operational, replaced on each report). Feeds the reference repositories picker. `local_key` is the
-- path relative to the repoRoot (never absolute); `remote_url_normalized` has no credentials.
CREATE TABLE IF NOT EXISTS workstation_repo_catalog (
  workstation_id        uuid NOT NULL REFERENCES workstations(id),
  local_key             text NOT NULL,
  name                  text NOT NULL,
  remote_url_normalized text,
  reported_at           timestamptz NOT NULL,
  PRIMARY KEY (workstation_id, local_key)
);

-- Reference repositories picked from workstation clones: [{workstationId, localKey, name, remoteUrlNormalized|null}].
-- Projection of ProjectReferenceReposSet (workstationRepos); rebuilt from events.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS reference_workstation_repos jsonb NOT NULL DEFAULT '[]';
