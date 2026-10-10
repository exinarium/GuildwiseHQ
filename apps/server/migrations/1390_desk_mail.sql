-- Desk mail (docs/design/desk-mail.md): one row per desk item the platform has dealt with, so the support address is
-- mailed once per item. Not a projection and no foreign key: a projection rebuild or a reboot never mails an item again.
-- state: 'sent' (own mail), 'digest' (listed in a digest mail), 'skipped' (below the minimum priority, out of scope,
-- switched off, already closed or too old when it was seen).
CREATE TABLE IF NOT EXISTS desk_mail_log (
  desk_item_id  uuid PRIMARY KEY,
  state         text NOT NULL CHECK (state IN ('sent','digest','skipped')),
  batch_id      uuid,
  mailed_at     timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS desk_mail_log_batch ON desk_mail_log (mailed_at) WHERE state <> 'skipped';

-- Everything that exists when this ships counts as seen: no backlog mail on the first start.
INSERT INTO desk_mail_log (desk_item_id, state, mailed_at)
  SELECT id, 'skipped', now() FROM desk_items ON CONFLICT DO NOTHING;
