-- "Add a workstation" wizard (docs/design/open-questions.md, "Runner installer with a guided setup").
-- One row per wizard session: a short-lived token (only its hash is stored) in the install script URLs, the one-time
-- pairing code made for it, and the progress the install script reports. Operational data like pairing_codes: it is not
-- event-sourced and nothing in it is a long-lived secret.
-- Safe to run again.
CREATE TABLE IF NOT EXISTS installer_sessions (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id           uuid NOT NULL REFERENCES users(id),
  token_hash        text NOT NULL UNIQUE,
  os                text NOT NULL CHECK (os IN ('linux', 'macos', 'windows')),
  workstation_name  text NOT NULL DEFAULT '',
  pairing_code_id   uuid REFERENCES pairing_codes(id),
  created_at        timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  script_fetched_at timestamptz,
  started_at        timestamptz,
  paired_at         timestamptz,
  finished_at       timestamptz,
  result            text,
  steps             jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS installer_sessions_user ON installer_sessions (user_id, created_at DESC);

-- Which workstation a pairing code created (the wizard follows its code to the workstation).
ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS workstation_id uuid;
