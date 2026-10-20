-- Per-project Claude accounts (docs/design/claude-accounts.md): the project's account key (NULL = each workstation's
-- main account) and the "use main when this one is out" switch (off by default; projection of ProjectClaudeAccountSet),
-- the account each shift ran on (NULL = main), and the last `claude.account.ensure` answer per workstation
-- (operational, written by the runner gateway: { "<key>": { state, detail, at, configDir } }).
ALTER TABLE projects ADD COLUMN claude_account_key text;
ALTER TABLE projects ADD COLUMN claude_account_fallback boolean NOT NULL DEFAULT false;
ALTER TABLE shifts ADD COLUMN account_key text;
ALTER TABLE workstations ADD COLUMN claude_account_ensure jsonb NOT NULL DEFAULT '{}'::jsonb;
