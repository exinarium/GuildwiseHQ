-- Security hardening after the 17 Nov 2026 incident (1.10.0). Additive and safe to run again: every statement is
-- IF NOT EXISTS (or idempotent), so it applies the same on an empty database, on a development database and on a
-- populated self-hosted one. Operational tables carry no foreign key to a projection table, so a projection rebuild
-- (TRUNCATE ... CASCADE of the projections) never empties them.

-- ---------------------------------------------------------------- sign-in protection (R2, R4, R5)
-- Every failed sign-in, step-up and reset second factor, plus the lock decisions and the "cleared" marks that end a
-- lock. Operational, no FK: an unknown address is recorded the same way as a known one.
CREATE TABLE IF NOT EXISTS login_failures (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  email_norm  text,
  user_id     uuid,
  ip          text,
  user_agent  text,
  reason      text NOT NULL CHECK (reason IN
                ('password','second_factor','step_up','reset_second_factor','blocked','locked','cleared'))
);
CREATE INDEX IF NOT EXISTS login_failures_email ON login_failures (email_norm, at DESC);
CREATE INDEX IF NOT EXISTS login_failures_ip ON login_failures (ip, at DESC);
CREATE INDEX IF NOT EXISTS login_failures_at ON login_failures (at DESC);
CREATE INDEX IF NOT EXISTS login_failures_user ON login_failures (user_id, at DESC) WHERE user_id IS NOT NULL;

-- How a session was started, and when its user last proved a second factor (or, without 2FA, the password).
ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS method text,
  ADD COLUMN IF NOT EXISTS second_factor_at timestamptz;

-- Wrong second-factor answers on a reset link (5 kill the link).
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- Projection of `SessionStarted`: one row per sign-in. `session_ref` is auth_sessions.id (the sha256 of the token,
-- never the token). `ua_family` is browser family plus OS, normalized, never the full user agent.
CREATE TABLE IF NOT EXISTS sign_ins (
  seq          bigint PRIMARY KEY,
  at           timestamptz NOT NULL,
  user_id      uuid NOT NULL,
  session_ref  text NOT NULL,
  method       text NOT NULL,
  ip           text,
  user_agent   text,
  ua_family    text,
  new_device   boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS sign_ins_session ON sign_ins (session_ref, user_id);
CREATE INDEX IF NOT EXISTS sign_ins_device ON sign_ins (user_id, ip, ua_family, at);

-- ---------------------------------------------------------------- block list (R1)
-- Projection of `PlatformBlockAdded` / `PlatformBlockRemoved`.
CREATE TABLE IF NOT EXISTS platform_blocklist (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('domain','email','ip','allow_domain')),
  value       text NOT NULL,
  note        text NOT NULL DEFAULT '',
  created_by  uuid,
  created_at  timestamptz NOT NULL,
  UNIQUE (kind, value)
);

-- ---------------------------------------------------------------- workstation consent (R9)
-- Projection of `WorkstationOrgServingSet`: which organizations a workstation works for.
CREATE TABLE IF NOT EXISTS workstation_org_serving (
  workstation_id  uuid NOT NULL,
  org_id          uuid NOT NULL,
  serving         boolean NOT NULL,
  set_by          uuid,
  set_at          timestamptz NOT NULL,
  PRIMARY KEY (workstation_id, org_id)
);
CREATE INDEX IF NOT EXISTS workstation_org_serving_org ON workstation_org_serving (org_id) WHERE serving;

-- ---------------------------------------------------------------- render job API (R16, R19, R23)
-- Projection of `RenderWorkerAdded` / `RenderWorkerRevoked`; `last_*`, `version` and `encoder*` are updated directly.
CREATE TABLE IF NOT EXISTS render_workers (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  created_by      uuid,
  created_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  last_seen_at    timestamptz,
  last_ip         text,
  version         text,
  encoder         text CHECK (encoder IS NULL OR encoder IN ('nvenc','cpu')),
  encoder_reason  text
);
-- Operational: one row per claim, heartbeat change, complete, fail or denied request. Pruned after 90 days.
CREATE TABLE IF NOT EXISTS render_worker_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL,
  worker_id  uuid,
  action     text NOT NULL,
  render_id  uuid,
  ip         text,
  outcome    text NOT NULL
);
CREATE INDEX IF NOT EXISTS render_worker_log_at ON render_worker_log (at DESC);
CREATE INDEX IF NOT EXISTS render_worker_log_worker ON render_worker_log (worker_id, at DESC);
ALTER TABLE video_renders
  ADD COLUMN IF NOT EXISTS worker_id uuid,
  ADD COLUMN IF NOT EXISTS encoder text CHECK (encoder IS NULL OR encoder IN ('nvenc','cpu','cpu_fallback'));

-- ---------------------------------------------------------------- super admin least privilege (R17)
-- Operational: "Lost your authenticator?" recoveries (2FA removed 24 h after the mailed link is confirmed).
CREATE TABLE IF NOT EXISTS two_factor_recoveries (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL,
  confirmed_at  timestamptz,
  effective_at  timestamptz,
  cancelled_at  timestamptz,
  done_at       timestamptz
);
CREATE INDEX IF NOT EXISTS two_factor_recoveries_user ON two_factor_recoveries (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS two_factor_recoveries_due ON two_factor_recoveries (effective_at)
  WHERE confirmed_at IS NOT NULL AND cancelled_at IS NULL AND done_at IS NULL;

-- Operational: a platform ownership transfer waiting for the Owner's consent (or the 7-day notice).
CREATE TABLE IF NOT EXISTS org_ownership_transfers (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  to_user_id    uuid NOT NULL,
  requested_by  uuid NOT NULL,
  created_at    timestamptz NOT NULL,
  effective_at  timestamptz NOT NULL,
  decided_at    timestamptz,
  decision      text                                    -- NULL while pending; values owned by the transfer code (R17-3)
);
CREATE INDEX IF NOT EXISTS org_ownership_transfers_org ON org_ownership_transfers (org_id, created_at DESC);

-- Set from `OrganizationCreated.simulation`: simulation tools only on organizations created as one.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_as_simulation boolean NOT NULL DEFAULT false;
-- Existing organizations: from their own `OrganizationCreated` event (an org switched to simulation later stays false).
UPDATE organizations o SET created_as_simulation = true
  FROM events e
 WHERE e.type = 'OrganizationCreated' AND e.payload->>'orgId' = o.id::text
   AND e.payload->>'simulation' = 'true' AND NOT o.created_as_simulation;

-- ---------------------------------------------------------------- passkey approvals (R22)
-- Projection of `WorkstationPasskeyAdded` / `WorkstationPasskeyRemoved`. The server only relays assertions; the runner
-- trusts a passkey only after a local `guildwise-runner passkey trust`.
CREATE TABLE IF NOT EXISTS workstation_passkeys (
  id              uuid PRIMARY KEY,
  workstation_id  uuid NOT NULL,
  user_id         uuid NOT NULL,
  credential_id   text NOT NULL UNIQUE,
  public_key      text NOT NULL,
  alg             integer NOT NULL,
  sign_count      bigint NOT NULL DEFAULT 0,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL,
  removed_at      timestamptz
);
CREATE INDEX IF NOT EXISTS workstation_passkeys_ws ON workstation_passkeys (workstation_id) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------- signed runners and the start-up refusal (R21, R27)
ALTER TABLE workstations
  ADD COLUMN IF NOT EXISTS release_signed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS release_key_id text,
  ADD COLUMN IF NOT EXISTS startup_refused text;

-- Operational: a notice mailed once per user and kind (`runner_reinstall`, ...).
CREATE TABLE IF NOT EXISTS security_notices (
  user_id  uuid NOT NULL,
  kind     text NOT NULL,
  sent_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, kind)
);

-- ---------------------------------------------------------------- release signing per deploy target (R30)
-- `{required, keyId, publicKey, artefact}`; set by `DeployTargetSigningSet`. NULL: no signature required.
ALTER TABLE deploy_targets ADD COLUMN IF NOT EXISTS signing jsonb;

-- Projection of `ReleaseArtefactSigned` (the signature itself is public data).
CREATE TABLE IF NOT EXISTS release_signatures (
  release_id       uuid NOT NULL,
  target_id        uuid NOT NULL,
  key_id           text NOT NULL,
  artefact_sha256  text NOT NULL,
  minisig          text NOT NULL,
  source           text NOT NULL CHECK (source IN ('workstation','upload')),
  by_user          uuid,
  at               timestamptz NOT NULL,
  PRIMARY KEY (release_id, target_id, key_id, artefact_sha256)
);

-- ---------------------------------------------------------------- one re-login for super admins (rv 7, R29)
-- Existing super-admin sessions have no `sign_ins` row, and the per-request check would refuse them as forged. Ending
-- them here asks for one more sign-in instead of raising false alarms. Nothing to do on an empty database.
DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE kind = 'super_admin');
