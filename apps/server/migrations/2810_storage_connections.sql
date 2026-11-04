-- Storage connections (a firm's own storage that form uploads and answers are written to).
-- The server stores a connection id, its kind, a display name, the workstation that holds it and its health.
-- It never stores a token, key, endpoint, bucket, folder path, file content or form answer.
CREATE TABLE IF NOT EXISTS storage_connections (           -- projection of the StorageConnection* events
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL,                                      -- onedrive | google_drive | s3 | local | vault
  label text NOT NULL,
  workstation_id uuid NOT NULL REFERENCES workstations(id),
  status text NOT NULL DEFAULT 'active',                   -- active | removed
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  removed_at timestamptz
);
CREATE INDEX IF NOT EXISTS storage_connections_org ON storage_connections(org_id);
CREATE INDEX IF NOT EXISTS storage_connections_ws ON storage_connections(workstation_id);

CREATE TABLE IF NOT EXISTS storage_connection_health (     -- operational, reported by the runner; kept over a rebuild
  connection_id uuid PRIMARY KEY REFERENCES storage_connections(id),
  state text NOT NULL,                                     -- pending | connected | needs_reauth | unavailable | permission | quota | not_on_workstation
  error_code text,
  message text,                                            -- one sentence, never a value, path or token
  checked_at timestamptz NOT NULL,
  last_ok_at timestamptz
);

CREATE TABLE IF NOT EXISTS storage_requests (              -- operational, short-lived (pruned after 24 h)
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES storage_connections(id),
  workstation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('connect','auth','test','remove')),
  state text NOT NULL,                                     -- pending | awaiting_user | done | failed | cancelled | expired
  prompt jsonb,                                            -- device sign-in only: { userCode, verificationUri, expiresAt }; never a token
  command_id uuid,
  error_code text,
  message text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS storage_requests_connection ON storage_requests(connection_id);
