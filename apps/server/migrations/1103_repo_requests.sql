-- Approved repository setup: an agent asks for a new GitHub repository for a project, the project owner approves on the
-- desk, the owner's runner creates it and the server adds it to the project (projection of the Repo* events).
CREATE TABLE repo_requests (
  id                    uuid PRIMARY KEY,
  org_id                uuid NOT NULL REFERENCES users(id),
  project_id            uuid NOT NULL REFERENCES projects(id),
  name                  text NOT NULL,
  visibility            text NOT NULL CHECK (visibility IN ('private','public')),
  description           text,
  requested_by_agent_id uuid NOT NULL REFERENCES agents(id),
  thread_id             uuid,
  desk_item_id          uuid NOT NULL,
  status                text NOT NULL CHECK (status IN ('pending','approved','rejected','created','failed')),
  workstation_id        uuid REFERENCES workstations(id),
  approved_by           uuid REFERENCES users(id),
  remote_url            text,
  local_path            text,
  project_repo_id       uuid,
  error                 text,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL
);
CREATE INDEX repo_requests_project ON repo_requests (project_id, created_at DESC);
CREATE INDEX repo_requests_desk ON repo_requests (desk_item_id);
-- One live request per repository name and project: a retried request never creates a second one.
CREATE UNIQUE INDEX repo_requests_live ON repo_requests (project_id, lower(name)) WHERE status IN ('pending','approved','created');
