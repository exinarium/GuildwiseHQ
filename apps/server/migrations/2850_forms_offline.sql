-- Runner offline during a public form (release 1.5.0): the client leaves an email address and gets a secure link when
-- the firm's runner is back. Operational, not event-sourced: the email (encrypted) must be deletable, and it is cleared
-- when the case closes. No answer, file, name, phone number, IP address or user agent is ever held here.
CREATE TABLE IF NOT EXISTS form_offline_requests (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  form_id             uuid NOT NULL,
  form_version        int NOT NULL,
  session_nonce       text NOT NULL UNIQUE,
  origin_link_id      text,
  journey_instance_id uuid,
  journey_visit       int,
  journey_wait_id     uuid,
  record_kind         text,
  record_id           text,
  workstation_ids     uuid[] NOT NULL DEFAULT '{}',
  email_enc           text,
  email_key           text,
  status              text NOT NULL
                      CHECK (status IN ('held','sending','sent','submitted','continued','expired','failed','cancelled')),
  attempts            int NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz,
  resends             int NOT NULL DEFAULT 0,
  error_code          text,
  attempted_at        timestamptz NOT NULL,
  hold_expires_at     timestamptz NOT NULL,
  link_id             text,
  link_expires_at     timestamptz,
  link_sent_at        timestamptz,
  submission_id       uuid,
  submitted_at        timestamptz,
  desk_item_id        uuid,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  closed_at           timestamptz
);
CREATE INDEX IF NOT EXISTS form_offline_requests_open ON form_offline_requests (status, next_attempt_at)
  WHERE status IN ('held','sending','sent');
CREATE INDEX IF NOT EXISTS form_offline_requests_wait ON form_offline_requests (journey_wait_id)
  WHERE journey_wait_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS form_offline_requests_link ON form_offline_requests (form_id, origin_link_id)
  WHERE origin_link_id IS NOT NULL AND status IN ('held','sending','sent');
CREATE UNIQUE INDEX IF NOT EXISTS form_offline_requests_email ON form_offline_requests (form_id, email_key)
  WHERE email_key IS NOT NULL AND status IN ('held','sending','sent');

ALTER TABLE workstations ADD COLUMN IF NOT EXISTS connected_at timestamptz;
ALTER TABLE form_client_links ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'client';
ALTER TABLE form_client_links ADD COLUMN IF NOT EXISTS offline_request_id uuid;
