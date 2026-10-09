-- Password reset links (self-service "Forgot password?" and the platform admin's "Send reset link").
-- Operational data like pairing_codes and invitations tokens: not event-sourced. Only the hash of the token is stored;
-- the token itself exists only in the emailed link. A link works once and expires after an hour. The password change
-- itself is the event-sourced `PasswordChanged`; an admin sending a link is the event `PasswordResetLinkSent`.
-- Safe to run again.
CREATE TABLE IF NOT EXISTS password_resets (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id       uuid NOT NULL REFERENCES users(id),
  token_hash    text NOT NULL UNIQUE,
  requested_by  uuid REFERENCES users(id),            -- NULL: the user asked on the sign-in page; else the super admin who sent it
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  ip            text
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets (user_id, created_at DESC);
