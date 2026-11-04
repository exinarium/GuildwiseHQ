-- Journey waits, gates, outbound webhook calls and inbound hook triggers (release 1.5.0).
-- journey_waits, journey_webhook_calls and journey_hook_triggers are projections (rebuilt from the log).
-- journey_hook_calls is operational: metadata only, no payload, no IP address.
CREATE TABLE IF NOT EXISTS journey_waits (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL,
  project_id       uuid NOT NULL,
  journey_id       uuid NOT NULL,
  instance_id      uuid NOT NULL,
  visit            integer NOT NULL,
  step_id          text NOT NULL,
  kind             text NOT NULL,
  status           text NOT NULL,
  started_at       timestamptz NOT NULL,
  deadline_at      timestamptz,
  next_fire_at     timestamptz,
  reminders_sent   integer NOT NULL DEFAULT 0,
  config           jsonb NOT NULL,
  link_id          text,
  link_expires_at  timestamptz,
  trigger_id       uuid,
  desk_item_id     uuid,
  approver_user_id uuid,
  approver_role    text,
  fell_back        boolean NOT NULL DEFAULT false,
  resolved_at      timestamptz,
  resolution       text,
  resolved_by      uuid,
  submission_id    uuid,
  events           jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (instance_id, visit)
);
CREATE INDEX IF NOT EXISTS journey_waits_due ON journey_waits (next_fire_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS journey_waits_link ON journey_waits (link_id) WHERE status IN ('open','escalated');
CREATE INDEX IF NOT EXISTS journey_waits_instance ON journey_waits (instance_id, started_at DESC);

CREATE TABLE IF NOT EXISTS journey_webhook_calls (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL,
  project_id       uuid NOT NULL,
  instance_id      uuid NOT NULL,
  visit            integer NOT NULL,
  step_id          text NOT NULL,
  workstation_id   uuid NOT NULL,
  status           text NOT NULL,
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  command_id       uuid,
  command_deadline timestamptz,
  last_http_status integer,
  last_error       text,
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz,
  UNIQUE (instance_id, visit)
);
CREATE INDEX IF NOT EXISTS journey_webhook_calls_due ON journey_webhook_calls (next_attempt_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS journey_hook_triggers (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL,
  project_id  uuid NOT NULL,
  journey_id  uuid NOT NULL,
  purpose     text NOT NULL,
  name        text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  secret_enc  text NOT NULL,
  scheme      text NOT NULL,
  mapping     jsonb NOT NULL,
  on_no_match text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL,
  rotated_at  timestamptz
);
CREATE INDEX IF NOT EXISTS journey_hook_triggers_journey ON journey_hook_triggers (journey_id);

CREATE TABLE IF NOT EXISTS journey_hook_calls (
  id               uuid PRIMARY KEY,
  trigger_id       uuid,
  org_id           uuid,
  at               timestamptz NOT NULL,
  status           integer NOT NULL,
  outcome          text NOT NULL,
  size_bytes       integer NOT NULL,
  latency_ms       integer NOT NULL,
  instance_id      uuid,
  idempotency_hash text
);
CREATE INDEX IF NOT EXISTS journey_hook_calls_trigger ON journey_hook_calls (trigger_id, at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS journey_hook_calls_idem ON journey_hook_calls (trigger_id, idempotency_hash)
  WHERE idempotency_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS journey_records_external ON journey_records (project_id, record_type, external_id)
  WHERE external_id IS NOT NULL;
