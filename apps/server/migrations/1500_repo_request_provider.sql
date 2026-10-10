-- Agents can ask for a repository on any supported git host (GitHub, GitLab, Azure DevOps, Bitbucket Cloud).
-- `provider` is the git host kind; `host` only for a GitHub Enterprise Server or self-managed GitLab.
ALTER TABLE repo_requests ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'github'
  CHECK (provider IN ('github','gitlab','bitbucket-cloud','azure-devops'));
ALTER TABLE repo_requests ADD COLUMN IF NOT EXISTS host text;
