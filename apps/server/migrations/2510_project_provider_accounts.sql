-- S-A: a project's account per provider or runtime other than Claude Code (docs/design/discovery-boardroom-registry.md,
-- "S-A as built"). Projection of ProjectProviderAccountSet: one row per (project, scope); no row = the main account.
-- `scope` is codex, gemini, or a provider key id (anthropic, openai, google, openai-compatible, bedrock, vertex, gateway);
-- `account_key` is a named account or `org` (the organization's key). Claude Code keeps projects.claude_account_key.
CREATE TABLE project_provider_accounts (
  project_id       uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  scope            text        NOT NULL,
  account_key      text        NOT NULL,
  fallback_to_main boolean     NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, scope)
);
