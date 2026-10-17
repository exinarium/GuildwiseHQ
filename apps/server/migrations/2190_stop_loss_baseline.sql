-- Stop-loss budgets (Lean Team v3) start counting at the deploy for cards that already exist: a card with a long history
-- must not be parked at its first claim because old shifts exceed the new budget. The baseline lives in its own small
-- table, not on `cards`, because projection rebuilds truncate `cards` and replay it from events; this table has no
-- foreign key, so a rebuild never touches it. A card without a row (every card created after this migration) counts
-- its whole history.
CREATE TABLE card_stop_loss_baseline (
  card_id uuid PRIMARY KEY,
  since   timestamptz NOT NULL
);
INSERT INTO card_stop_loss_baseline (card_id, since)
  SELECT id, now() FROM cards WHERE status NOT IN ('done', 'cancelled')
  ON CONFLICT DO NOTHING;
