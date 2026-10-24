-- R3c, owner decision Q67: the server keeps no copy of an authored pack's text, so a reviewer who asks to read it while the author's
-- workstation is offline waits. This remembers who is waiting (operational state, not an event projection) so that they can be told
-- on their desk when that workstation connects. The wait carries no text.
CREATE TABLE IF NOT EXISTS pack_review_waits (
  pack_id           uuid NOT NULL,
  reviewer_user_id  uuid NOT NULL,
  org_id            uuid NOT NULL,
  workstation_id    uuid NOT NULL,
  requested_at      timestamptz NOT NULL,
  notified_at       timestamptz,
  PRIMARY KEY (pack_id, reviewer_user_id)
);
CREATE INDEX IF NOT EXISTS pack_review_waits_ws ON pack_review_waits (workstation_id) WHERE notified_at IS NULL;
