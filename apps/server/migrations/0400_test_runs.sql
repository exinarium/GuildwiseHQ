-- M4: evidence of every tester verdict (docs/ARCHITECTURE.md section 4.2). A projection of TestPassed, TestFailed,
-- FullSuitePassed and FullSuiteFailed; rebuilt from events.
CREATE TABLE test_runs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  card_id     uuid NOT NULL REFERENCES cards(id),
  shift_id    uuid,
  kind        text NOT NULL CHECK (kind IN ('feature','full_suite','regression')),
  platform    text CHECK (platform IN ('web','mobile')),
  result      text NOT NULL CHECK (result IN ('passed','failed')),
  evidence    jsonb NOT NULL DEFAULT '{}',
  event_seq   bigint NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX test_runs_card ON test_runs (card_id, created_at);
