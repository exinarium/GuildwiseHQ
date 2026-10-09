-- DevOps workstation setup (docs/RUNNER.md "Repository setup, toolchain and rights").

-- Where a project repository stands on each workstation of the project: being cloned, cloned, created, failed or
-- waiting for the manager. A projection of RepoCloneRequested / RepoCloneReported.
CREATE TABLE repo_clones (
  project_repo_id uuid NOT NULL REFERENCES project_repos(id) ON DELETE CASCADE,
  workstation_id  uuid NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state           text NOT NULL CHECK (state IN ('cloning','cloned','created','failed','needs_manager')),
  mode            text NOT NULL DEFAULT 'clone' CHECK (mode IN ('clone','create')),
  detail          text,
  create_spec     jsonb,          -- "create new": {name, visibility, description} (kept for the retry)
  local_path      text,
  request_id      uuid,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (project_repo_id, workstation_id)
);
CREATE INDEX repo_clones_project ON repo_clones (project_id);

-- Is the toolchain of a project ready on a workstation? A row exists once the DevOps engineer started preparing it;
-- a project without a row is not gated. Cards of the build and test stages wait while the state is not 'ready'
-- (dispatcher eligibility "env"). A projection of EnvironmentPrepareRequested / EnvironmentPrepared.
CREATE TABLE project_environments (
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workstation_id uuid NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  state          text NOT NULL CHECK (state IN ('preparing','ready','failed','needs_access')),
  summary        text,
  report         jsonb,
  request_id     uuid,
  updated_at     timestamptz NOT NULL,
  PRIMARY KEY (project_id, workstation_id)
);
CREATE INDEX project_environments_ws ON project_environments (workstation_id) WHERE state <> 'ready';

-- Rights check of the DevOps engineer's ticked capabilities (DevOpsRightsVerified) and the sudo password facts
-- (DevOpsSudoPasswordSet / Cleared: whether one is stored on the runner, never the password).
ALTER TABLE workstations
  ADD COLUMN devops_rights        jsonb,
  ADD COLUMN devops_rights_stale  boolean NOT NULL DEFAULT false,
  ADD COLUMN devops_sudo_set_at   timestamptz,
  ADD COLUMN devops_sudo_works    boolean,
  ADD COLUMN devops_sudo_key_id   text;

-- The runner's public key for the sudo password, as announced in `hello`. Operational (not a projection): saved and
-- restored by the projection rebuild. Public information; the private half never leaves the runner.
CREATE TABLE workstation_keys (
  workstation_id uuid PRIMARY KEY REFERENCES workstations(id) ON DELETE CASCADE,
  key_id         text NOT NULL,
  public_key     text NOT NULL,
  updated_at     timestamptz NOT NULL
);
