-- Git hosts per repository (docs/design/cloud-workstations-and-forges.md Part 2, owner decisions G-Q6/C4, C5, C9).
-- The provider is chosen per project repository: detected from the URL, with a manual override stored here.
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS forge_kind text
  CHECK (forge_kind IS NULL OR forge_kind IN ('github','gitlab','bitbucket-cloud','bitbucket-dc','azure-devops','git'));

-- Which git providers a workstation says it is connected to (state only: connected / not connected, never a secret).
-- Reported by the runner (`git.report`). Credentials stay on the workstation.
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS git_connections jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS git_checked_at timestamptz;

-- The repository picker: the workstation lists the user's repositories on a connected provider and the page polls for
-- the answer. Not event-sourced: short-lived read-through data (rows older than a day are removed on the next request).
CREATE TABLE IF NOT EXISTS forge_repo_lists (
  request_id      uuid PRIMARY KEY,
  workstation_id  uuid NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  provider        text NOT NULL,
  search          text,
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','failed')),
  repos           jsonb NOT NULL DEFAULT '[]'::jsonb,
  error           text,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS forge_repo_lists_workstation ON forge_repo_lists (workstation_id, created_at);
