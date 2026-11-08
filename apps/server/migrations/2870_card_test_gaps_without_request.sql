-- A builder test gap may have no DevOps request: no DevOps engineer was on the workstation, so nobody was asked.
ALTER TABLE card_test_gaps ADD COLUMN IF NOT EXISTS gap_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE card_test_gaps DROP CONSTRAINT IF EXISTS card_test_gaps_pkey;
ALTER TABLE card_test_gaps ADD PRIMARY KEY (gap_id);
ALTER TABLE card_test_gaps ALTER COLUMN request_id DROP NOT NULL;
-- Keeps one gap per card and request for gaps with a request; NULLs are distinct, so request-less gaps are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS card_test_gaps_card_request ON card_test_gaps (card_id, request_id);
