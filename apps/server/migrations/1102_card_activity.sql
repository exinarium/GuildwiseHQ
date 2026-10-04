-- Timeline entries that are not stage or status changes: field edits and risk tier overrides (projection of CardUpdated).
CREATE TABLE card_activity (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id    uuid NOT NULL REFERENCES cards(id),
  kind       text NOT NULL,                       -- edited | risk_tier
  summary    text NOT NULL,
  reason     text,
  user_id    uuid REFERENCES users(id),
  agent_id   uuid REFERENCES agents(id),
  event_seq  bigint NOT NULL,
  at         timestamptz NOT NULL
);
CREATE INDEX card_activity_card ON card_activity (card_id, id);
