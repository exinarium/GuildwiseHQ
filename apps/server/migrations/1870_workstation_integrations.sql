-- The Integrations page (backlog #34, #60; docs/design/integrations-page.md section 5.3).
-- Operational data, not projections: a rebuild of the projections leaves it alone.

-- The latest fact record the runner reported per (workstation, kind, instance). Facts only: never a token, key or code.
CREATE TABLE workstation_integrations (
  workstation_id uuid NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  instance       text NOT NULL DEFAULT '',
  status         jsonb NOT NULL,
  checked_at     timestamptz NOT NULL,
  PRIMARY KEY (workstation_id, kind, instance)
);

-- One row per connect / sign-in session / test / remove the page asked for. Short-lived: rows older than a day are deleted.
-- `prompt` holds the sign-in link and device code, never a secret.
CREATE TABLE integration_requests (
  id             uuid PRIMARY KEY,
  workstation_id uuid NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL,
  kind           text NOT NULL,
  instance       text NOT NULL DEFAULT '',
  op             text NOT NULL CHECK (op IN ('connect','session','test','remove')),
  method         text,
  state          text NOT NULL,   -- pending | awaiting_user | awaiting_code | completing | done | connected | failed | cancelled | expired
  prompt         jsonb,
  status         jsonb,
  error          text,
  inputs         integer NOT NULL DEFAULT 0,
  command_id     uuid,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL
);
CREATE INDEX integration_requests_ws_state ON integration_requests (workstation_id, state);

-- Commands that carry a sealed envelope expire: a sweep empties and fails the ones nobody collected.
ALTER TABLE runner_commands ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- What the runner announced: web connect support, whether it is the machine's primary pairing, the local policy switch.
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS integrations_version integer;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS integrations_policy jsonb;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS integrations_checked_at timestamptz;
