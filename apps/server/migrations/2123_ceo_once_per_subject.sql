-- Once per subject (Lean Team v3, stream S1b): a wake carries a durable key for what it is about (a subject and a reason) and
-- the state of that subject when it was raised. While a wake with the same key and state is pending, taken or done, the
-- same subject does not wake the CEO again; it can when its state changes ("the card is in Manual QA" is handled once).
ALTER TABLE ceo_wakes
  ADD COLUMN dedupe_key   text,
  ADD COLUMN dedupe_state text;
CREATE INDEX ceo_wakes_dedupe ON ceo_wakes (org_id, dedupe_key, created_at DESC) WHERE dedupe_key IS NOT NULL;
