-- Files of an expired public form submission that the server removes from the firm's storage (GWP-143).
-- Operational, like form_submissions: references only (connection, stored path), never file content.
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS cleanup_queued_at timestamptz;

CREATE TABLE IF NOT EXISTS form_submission_cleanup (
  submission_id    uuid NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
  seq              smallint NOT NULL,
  org_id           uuid NOT NULL,
  connection_id    uuid NOT NULL,
  label            text NOT NULL,
  path             text NOT NULL,
  provider_id      text,
  state            text NOT NULL CHECK (state IN ('pending','removed','failed')),
  attempts         integer NOT NULL DEFAULT 0,
  last_error_code  text,
  last_error       text,
  queued_at        timestamptz NOT NULL,
  next_attempt_at  timestamptz NOT NULL,
  settled_at       timestamptz,
  PRIMARY KEY (submission_id, seq)
);
CREATE INDEX IF NOT EXISTS form_submission_cleanup_due ON form_submission_cleanup (next_attempt_at) WHERE state = 'pending';
