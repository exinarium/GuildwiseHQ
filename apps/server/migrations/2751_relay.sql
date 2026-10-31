-- Inbound webhook relay (business mode). The server stores the sha256 of the public path token and metadata only:
-- never a body, a header value, a query string, a token or a provider secret.
CREATE TABLE IF NOT EXISTS relay_integrations (            -- projection of the RelayIntegration* events
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  token_hash text UNIQUE,                                  -- sha256 hex; NULL once revoked
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS relay_integrations_org ON relay_integrations(org_id);

CREATE TABLE IF NOT EXISTS relay_presence (                -- operational state, not event-sourced
  integration_id uuid PRIMARY KEY REFERENCES relay_integrations(id),
  last_served_at timestamptz NOT NULL,
  offline_since timestamptz
);

CREATE TABLE IF NOT EXISTS relay_requests (                -- metadata only; pruned after AOM_RELAY_RETENTION_DAYS
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  org_id uuid,
  integration_id uuid,
  kind text,
  method text NOT NULL,
  size_bytes integer NOT NULL,
  status smallint NOT NULL,
  latency_ms integer NOT NULL,
  outcome text NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_requests_integration_at ON relay_requests(integration_id, at);
CREATE INDEX IF NOT EXISTS relay_requests_at ON relay_requests(at);
