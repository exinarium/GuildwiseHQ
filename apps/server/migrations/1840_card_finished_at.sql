-- When a card was finished (done or cancelled): done cards leave the board a day later and live in the project's
-- archive (#51). A projection column, kept by a trigger so every projection path that finishes or reopens a card
-- (finalize, feeds, testing, research, cancel, reopen, a rebuild) sets and clears it the same way. The value is the
-- event time (`updated_at` of the update that finished the card).
ALTER TABLE cards ADD COLUMN finished_at timestamptz;

UPDATE cards
   SET finished_at = CASE WHEN status = 'done' THEN COALESCE(finalized_at, updated_at) ELSE updated_at END
 WHERE status IN ('done', 'cancelled');

CREATE FUNCTION cards_set_finished_at() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('done', 'cancelled') THEN
    -- entering a finished status stamps the time, unless the same statement set the column itself
    IF TG_OP = 'INSERT' OR OLD.status NOT IN ('done', 'cancelled') THEN
      IF TG_OP = 'INSERT' OR NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at THEN
        NEW.finished_at := NEW.updated_at;
      END IF;
    END IF;
  ELSE
    NEW.finished_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cards_finished_at BEFORE INSERT OR UPDATE ON cards
  FOR EACH ROW EXECUTE FUNCTION cards_set_finished_at();

CREATE INDEX cards_project_finished_idx ON cards (project_id, finished_at DESC) WHERE finished_at IS NOT NULL;
