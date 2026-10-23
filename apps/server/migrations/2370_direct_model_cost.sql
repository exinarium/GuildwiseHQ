-- Direct-model runtime (phase D): a session turn on a provider model that has no price in the tables is costed 0 and flagged,
-- so the cost pages and the session meter can say "cost unknown" instead of showing a silent zero.
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS cost_unknown boolean NOT NULL DEFAULT false;
