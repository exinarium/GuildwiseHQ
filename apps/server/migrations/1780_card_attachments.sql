-- Card attachments (docs/USER-GUIDE.md "Attachments") and the Jira status of a workstation (docs/RUNNER.md).
-- card_attachments: metadata, a projection of CardAttachmentAdded / CardAttachmentRemoved (rebuilt from events).
-- card_attachment_data: the bytes. Operational, never in the event log, kept over a projection rebuild. No foreign key to
-- the projection table (a rebuild truncates it); rows are deleted when the attachment is removed.
-- card_attachment_uploads: a one-time ticket the runner gets for a file an agent attaches (`aom card attach`).
CREATE TABLE IF NOT EXISTS card_attachments (
  id              uuid PRIMARY KEY,
  card_id         uuid NOT NULL REFERENCES cards(id),
  org_id          uuid,
  name            text NOT NULL,
  content_type    text NOT NULL,
  size            integer NOT NULL,
  sha256          text NOT NULL,
  source          text,
  added_by_user   uuid,
  added_by_agent  uuid,
  event_seq       bigint NOT NULL,
  created_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS card_attachments_card ON card_attachments (card_id, created_at);

CREATE TABLE IF NOT EXISTS card_attachment_data (
  id    uuid PRIMARY KEY,
  data  bytea NOT NULL
);

CREATE TABLE IF NOT EXISTS card_attachment_uploads (
  id              uuid PRIMARY KEY,
  workstation_id  uuid NOT NULL,
  shift_id        uuid NOT NULL,
  card_id         uuid NOT NULL,
  agent_id        uuid NOT NULL,
  name            text NOT NULL,
  size            integer NOT NULL,
  sha256          text NOT NULL,
  source          text,
  expires_at      timestamptz NOT NULL
);

ALTER TABLE workstations ADD COLUMN IF NOT EXISTS jira_status     jsonb;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS jira_checked_at timestamptz;
