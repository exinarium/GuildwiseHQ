-- Owner decision 2026-10-25: an @mention may edit and run commands in the card's working folder (within what the commenter may
-- grant). A running work mention keeps the card from being claimed by a shift; replay-safe (old rows are read-only mentions).
ALTER TABLE card_mentions ADD COLUMN IF NOT EXISTS work boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS card_mentions_work ON card_mentions (card_id) WHERE work AND status = 'running';
