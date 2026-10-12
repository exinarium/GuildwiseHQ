-- Two branches per project repository: the main branch (where pull requests go; NULL: the repository's default branch)
-- and the working branch (where card work is integrated; `working_branch`, may equal the main branch).
-- Projection of ProjectRepoAdded.mainBranch / ProjectRepoMainBranchSet / ProjectRepoWorkingBranchCreated; rebuilt from events.
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS main_branch text;
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS working_branch_created_at timestamptz;
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS working_branch_created_from text;
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS working_branch_created_pushed boolean;

-- "Open a pull request from the working branch to the main branch" (project settings button): the workstation opens it
-- and the page polls for the answer. Not event-sourced: short-lived read-through data, the last row per repository is shown.
CREATE TABLE IF NOT EXISTS repo_pr_requests (
  request_id      uuid PRIMARY KEY,
  project_id      uuid NOT NULL,
  repo_id         uuid NOT NULL,
  workstation_id  uuid NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  requested_by    uuid REFERENCES users(id),
  head            text NOT NULL,
  base            text,
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','opened','nothing','failed')),
  url             text,
  message         text,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS repo_pr_requests_repo ON repo_pr_requests (repo_id, created_at DESC);
