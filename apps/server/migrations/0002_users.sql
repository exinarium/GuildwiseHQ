CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  email          text NOT NULL,
  display_name   text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin','member')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  created_at     timestamptz NOT NULL,
  deactivated_at timestamptz,
  last_login_at  timestamptz                         -- operational
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE invitations (
  id               uuid PRIMARY KEY,
  email            text NOT NULL,
  role             text NOT NULL CHECK (role IN ('admin','member')),
  token_hash       text NOT NULL UNIQUE,              -- sha256 hex of the 32-byte token
  invited_by       uuid REFERENCES users(id),
  status           text NOT NULL CHECK (status IN ('pending','accepted','revoked')),
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_user_id uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX invitations_one_pending_per_email ON invitations (lower(email)) WHERE status = 'pending';

-- Operational (not event sourced): login sessions
CREATE TABLE auth_sessions (
  id           text PRIMARY KEY,                      -- sha256 hex of cookie token
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  ip           inet
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);
