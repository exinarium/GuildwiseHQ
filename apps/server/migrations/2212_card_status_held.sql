-- A card whose design is accepted before its dependencies landed has the status 'held' (not 'queued'): it is not
-- work waiting for an agent. The projection returns it to 'queued' once every dependency has landed.
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_status_check;
ALTER TABLE cards ADD CONSTRAINT cards_status_check
  CHECK (status IN ('draft','queued','claimed','blocked','waiting','held','done','cancelled'));
CREATE INDEX IF NOT EXISTS cards_held_idx ON cards (id) WHERE status = 'held';
