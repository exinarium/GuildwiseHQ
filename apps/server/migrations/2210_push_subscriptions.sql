-- Web Push (mobile PWA). Operational tables, like the briefing preferences: browser subscriptions, notification
-- preferences and the once-per-subject ledger are not events and cannot be rebuilt from them. None of them has a foreign
-- key to a projection table, so the replay's TRUNCATE ... CASCADE leaves them alone (see projections/rebuild.ts).

-- One row per person and device (a browser's push endpoint is unique). Removed when the push service answers 404/410.
CREATE TABLE push_subscriptions (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL,
  endpoint         text NOT NULL UNIQUE,
  p256dh           text NOT NULL,
  auth             text NOT NULL,
  label            text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL,
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  failure_count    integer NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- Categories on or off, quiet hours. org_id = the nil UUID is the person's default for every organization; a row for
-- an organization overrides it there.
CREATE TABLE push_prefs (
  user_id     uuid NOT NULL,
  org_id      uuid NOT NULL,
  categories  jsonb NOT NULL DEFAULT '{}',
  quiet       jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, org_id)
);

-- Once per subject: the last state a person was notified about for (category, subject), so the same thing is not sent
-- again within 24 hours unless its state changed.
CREATE TABLE push_deliveries (
  user_id   uuid NOT NULL,
  category  text NOT NULL,
  subject   text NOT NULL,
  state     text NOT NULL DEFAULT '',
  sent_at   timestamptz NOT NULL,
  PRIMARY KEY (user_id, category, subject)
);
