-- Lean Team v3, runner 0.1.24: session context size on the shift, runner errors (deduped by signature), the DevOps
-- command audit trail and roles whose smoke test failed on a workstation.

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS context_tokens integer;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS resume_state text;

-- Unhandled errors the runner reports (sanitised on the runner). One row per signature, with a counter.
CREATE TABLE IF NOT EXISTS runner_errors (
  signature       text PRIMARY KEY,
  message         text NOT NULL,
  stack           text,
  context         text,
  first_version   text NOT NULL,
  last_version    text NOT NULL,
  last_workstation_id uuid,
  workstation_count integer NOT NULL DEFAULT 1,
  occurrences     integer NOT NULL DEFAULT 1,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  -- set by the platform team's bug intake once a card exists for this signature
  bug_card_id     uuid
);
CREATE INDEX IF NOT EXISTS runner_errors_last_seen ON runner_errors (last_seen_at DESC);

-- Which workstations hit a signature (for the workstation count).
CREATE TABLE IF NOT EXISTS runner_error_workstations (
  signature       text NOT NULL REFERENCES runner_errors(signature) ON DELETE CASCADE,
  workstation_id  uuid NOT NULL,
  PRIMARY KEY (signature, workstation_id)
);

-- Every shell command of a DevOps session (allowed or refused), as the guard hook saw it.
CREATE TABLE IF NOT EXISTS devops_audit (
  id              bigserial PRIMARY KEY,
  workstation_id  uuid NOT NULL,
  at              timestamptz NOT NULL,
  session_ref     text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('shift', 'chat')),
  decision        text NOT NULL CHECK (decision IN ('allowed', 'refused')),
  rule            text NOT NULL,
  command         text NOT NULL
);
CREATE INDEX IF NOT EXISTS devops_audit_ws_at ON devops_audit (workstation_id, at DESC);
CREATE INDEX IF NOT EXISTS devops_audit_refused ON devops_audit (at DESC) WHERE decision = 'refused';

-- Roles whose smoke test failed on a workstation: the dispatcher offers them no work there until a later run passes.
CREATE TABLE IF NOT EXISTS workstation_role_blocks (
  workstation_id  uuid NOT NULL,
  role_key        text NOT NULL,
  detail          text,
  runner_version  text,
  checked_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workstation_id, role_key)
);
