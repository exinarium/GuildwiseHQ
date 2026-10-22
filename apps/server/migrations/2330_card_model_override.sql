-- A per-card model override (CardModelRaised): the card's next shifts run on this model and effort instead of the agent's own.
-- Nullable and additive; a projection rebuild refills it from the events.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS model_override jsonb;
