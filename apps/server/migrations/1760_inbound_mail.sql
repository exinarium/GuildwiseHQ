-- Inbound e-mail (docs/design/workflow-builder.md D9, WP7). Operational tables, like support tickets: message text does
-- not enter the event log (the events `MailReceived`, `MailThreadLinked`, ... are the audit trail and feed the trigger
-- sweep). No foreign keys to projection tables, so a projection rebuild never empties them.

-- An organisation's inbox: a label, an allow-list of senders whose cards may be queued directly (full addresses and
-- `@domain` entries), and a switch. Its address lives in mail_addresses so a rotation keeps the old one on record.
CREATE TABLE mail_inboxes (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL,
  project_id  uuid,
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  enabled     boolean NOT NULL DEFAULT true,
  allow_list  text[] NOT NULL DEFAULT '{}',
  created_by  uuid,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX mail_inboxes_org ON mail_inboxes (org_id);

-- `address` is the full lower-case address (`<slug>-<random>@<inbound domain>`). Exactly one active address per inbox;
-- retired ones are kept so mail to them is recorded as skipped, never delivered to anybody else.
CREATE TABLE mail_addresses (
  address    text PRIMARY KEY,
  inbox_id   uuid NOT NULL REFERENCES mail_inboxes(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  retired_at timestamptz
);
CREATE UNIQUE INDEX mail_addresses_active ON mail_addresses (inbox_id) WHERE active;

-- A conversation. `token` goes into plus-addresses (`slug-ab12+<token>@domain`) of replies we ask for. `card_id` is
-- set when the first message made a card (MailThreadLinked); `untrusted_fields` are the card fields filled from it.
CREATE TABLE mail_threads (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL,
  inbox_id         uuid NOT NULL REFERENCES mail_inboxes(id),
  token            text NOT NULL UNIQUE,
  subject_norm     text NOT NULL DEFAULT '',
  card_id          uuid,
  untrusted_fields text[] NOT NULL DEFAULT '{}',
  untrusted_title  boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL,
  last_message_at  timestamptz NOT NULL
);
CREATE INDEX mail_threads_inbox ON mail_threads (inbox_id, last_message_at DESC);
CREATE INDEX mail_threads_card ON mail_threads (card_id) WHERE card_id IS NOT NULL;

-- One row per message, in and out. `message_id` is the Message-ID header (with angle brackets); (inbox, message_id) is
-- unique so a provider retry stores nothing twice. Text only: HTML is turned into text, attachments are metadata.
CREATE TABLE mail_messages (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  inbox_id        uuid NOT NULL REFERENCES mail_inboxes(id),
  thread_id       uuid NOT NULL REFERENCES mail_threads(id),
  direction       text NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  message_id      text,
  in_reply_to     text,
  refs            text[] NOT NULL DEFAULT '{}',
  from_address    text NOT NULL,
  from_name       text,
  to_address      text NOT NULL DEFAULT '',
  subject         text NOT NULL DEFAULT '',
  body_text       text NOT NULL DEFAULT '',
  body_truncated  boolean NOT NULL DEFAULT false,
  received_at     timestamptz NOT NULL,
  status          text NOT NULL CHECK (status IN ('received','card_created','draft_created','comment_added','processed','skipped')),
  reason          text,
  auth            text NOT NULL DEFAULT 'unknown' CHECK (auth IN ('pass','fail','unknown')),
  spam_score      numeric,
  allow_listed    boolean NOT NULL DEFAULT false,
  attachments     jsonb NOT NULL DEFAULT '[]',
  card_id         uuid
);
CREATE UNIQUE INDEX mail_messages_dedupe ON mail_messages (inbox_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX mail_messages_inbox ON mail_messages (inbox_id, received_at DESC);
CREATE INDEX mail_messages_thread ON mail_messages (thread_id, received_at);
CREATE INDEX mail_messages_rate ON mail_messages (org_id, received_at) WHERE direction = 'in';

-- Counters for what reaches the webhook without belonging to an organisation (unknown address, bad credentials): the
-- super admin's health view. One row per day and kind.
CREATE TABLE inbound_counters (
  day  date NOT NULL,
  kind text NOT NULL,
  n    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
