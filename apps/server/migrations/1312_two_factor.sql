-- Two-factor login (TOTP, owner decision 7). Operational tables (like auth_sessions): the secret and the hashed
-- recovery codes never enter the event log; `TwoFactorEnabled` / `TwoFactorDisabled` events record that it happened.

CREATE TABLE user_totp (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc      text NOT NULL,                 -- AES-256-GCM, `v1:<iv>:<tag>:<ciphertext>` (base64url)
  confirmed_at    timestamptz,                   -- NULL while the enrolment is pending
  last_used_step  bigint,                        -- the last accepted 30-second step: a code works once
  created_at      timestamptz NOT NULL
);

CREATE TABLE user_recovery_codes (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,                     -- sha256 hex of the normalised code
  used_at     timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

-- A password-verified login waiting for its second factor.
CREATE TABLE login_challenges (
  id          text PRIMARY KEY,                  -- sha256 hex of the challenge token
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  user_agent  text,
  ip          text
);
CREATE INDEX login_challenges_user ON login_challenges (user_id);

-- The key that encrypts TOTP secrets when AOM_SECRET_KEY is not set (generated on first use).
CREATE TABLE server_secrets (
  name        text PRIMARY KEY,
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
