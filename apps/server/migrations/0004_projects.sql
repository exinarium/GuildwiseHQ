CREATE TABLE projects (
  id                 uuid PRIMARY KEY,
  org_id             uuid NOT NULL REFERENCES users(id),
  key                text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name               text NOT NULL,
  domain             text NOT NULL CHECK (domain IN ('work','personal')),
  workflow_key       text NOT NULL DEFAULT 'code',     -- default workflow for new cards
  priority_tier      smallint NOT NULL DEFAULT 2 CHECK (priority_tier BETWEEN 1 AND 4), -- 1 = highest
  branch_prefix      text NOT NULL DEFAULT 'aom/',
  working_branch     text NOT NULL DEFAULT 'main',
  sub_categories     text[] NOT NULL DEFAULT '{}',
  vault_folder       text,                             -- projects/<name> inside the domain vault
  architectural_globs text[] NOT NULL DEFAULT '{}',    -- touching these makes risk tier large
  e2e_globs          text[] NOT NULL DEFAULT '{e2e/**,tests/e2e/**,playwright/**}',
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  next_card_number   integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL,
  UNIQUE (org_id, key)
);

CREATE TABLE project_repos (
  id                    uuid PRIMARY KEY,
  project_id            uuid NOT NULL REFERENCES projects(id),
  name                  text NOT NULL,
  remote_url            text NOT NULL,
  remote_url_normalized text NOT NULL,   -- lowercased host/path, no scheme/user/.git: github.com/acme/web
  working_branch        text,            -- overrides projects.working_branch
  removed_at            timestamptz,
  UNIQUE (project_id, remote_url_normalized)
);

CREATE TABLE project_members (
  project_id  uuid NOT NULL REFERENCES projects(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('owner','manager')),
  status      text NOT NULL CHECK (status IN ('invited','active','removed')),
  invited_by  uuid REFERENCES users(id),
  invited_at  timestamptz,
  joined_at   timestamptz,
  removed_at  timestamptz,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members (user_id) WHERE status = 'active';
-- The owner always has an 'owner' row (written by the ProjectCreated projector) so visibility is one join.

CREATE TABLE workstation_repos (                     -- projection of runner hello/repos.report (operational)
  workstation_id  uuid NOT NULL REFERENCES workstations(id),
  project_repo_id uuid NOT NULL REFERENCES project_repos(id),
  local_path      text NOT NULL,
  reported_at     timestamptz NOT NULL,
  PRIMARY KEY (workstation_id, project_repo_id)
);
