-- Automated app integrations (a GitHub App first). Metadata only: the private key and every token stay on the runners.
CREATE TABLE IF NOT EXISTS org_app_integrations (            -- projection of OrgAppIntegration* events (no FKs: rebuildable)
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  provider text NOT NULL,
  label text NOT NULL,
  host text NOT NULL,
  app_id text NOT NULL,
  app_slug text NOT NULL,
  app_name text NOT NULL,
  installation_id text NOT NULL,
  account text NOT NULL,
  account_type text,
  repository_selection text,
  bot_login text NOT NULL,
  bot_user_id text NOT NULL,
  commit_name text NOT NULL,
  commit_email text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',                     -- active | removed
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  removed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS org_app_integrations_one
  ON org_app_integrations (org_id, provider, host, app_id, installation_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS org_app_integration_workstations ( -- projection of ...Shared / ...Unshared
  integration_id uuid NOT NULL,
  workstation_id uuid NOT NULL,
  via text NOT NULL,
  added_by uuid,
  added_at timestamptz NOT NULL,
  PRIMARY KEY (integration_id, workstation_id)
);

CREATE TABLE IF NOT EXISTS app_integration_requests (         -- operational, short-lived (pruned after 24 h)
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  integration_id uuid,
  user_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('add', 'share', 'test', 'adopt')),
  label text,
  state text NOT NULL,                                        -- pending | needs_choice | done | failed | expired
  results jsonb NOT NULL DEFAULT '[]'::jsonb,                 -- [{workstationId, commandId, ok?, code?, message?}] never a value
  installations jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS app_integration_requests_expires ON app_integration_requests (expires_at);
