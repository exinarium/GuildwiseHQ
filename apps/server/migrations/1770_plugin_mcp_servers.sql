-- Plugin MCP servers (docs/RUNNER.md "Plugin MCP servers").
-- workstations.mcp_servers: what the runner reports on each `mcp.servers` (operational, replaced on every report, kept over
-- a projection rebuild): [{name, plugin, server, transport, host?, tools?}]. Names and facts only, never a secret.
-- projects.mcp_servers: the names the organization's Owner granted to the project (projection of ProjectMcpServersSet).
-- shifts.mcp_calls: the MCP tools a shift called, [{server, tool, count}] (operational, derived from the shift's tool log).
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS mcp_servers            jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS mcp_servers_checked_at timestamptz;
ALTER TABLE projects     ADD COLUMN IF NOT EXISTS mcp_servers            text[] NOT NULL DEFAULT '{}';
ALTER TABLE shifts       ADD COLUMN IF NOT EXISTS mcp_calls              jsonb NOT NULL DEFAULT '[]'::jsonb;
