-- Builder test runs that went to DevOps without parking the card ("Test without an environment").
CREATE TABLE IF NOT EXISTS card_test_gaps (
  card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  agent_id uuid,
  stage text NOT NULL,
  reason text NOT NULL,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  result_status text,
  result_summary text,
  result_at timestamptz,
  PRIMARY KEY (card_id, request_id)
);
