-- Revision R2: option scoring tally of the Boardroom (one row per option and participant).
-- Projection table rebuilt from `BoardOptionScored` (no foreign keys: a rebuild TRUNCATEs it).
CREATE TABLE IF NOT EXISTS board_scores (
  thread_id      uuid NOT NULL,
  org_id         uuid NOT NULL,
  option_key     text NOT NULL,
  option         text NOT NULL,
  participant_id text NOT NULL,
  name           text NOT NULL,
  score          int NOT NULL CHECK (score BETWEEN 1 AND 5),
  why            text NOT NULL DEFAULT '',
  round          int,
  seq            bigint NOT NULL,
  updated_at     timestamptz NOT NULL,
  PRIMARY KEY (thread_id, option_key, participant_id)
);
CREATE INDEX IF NOT EXISTS board_scores_thread ON board_scores (thread_id, seq);
