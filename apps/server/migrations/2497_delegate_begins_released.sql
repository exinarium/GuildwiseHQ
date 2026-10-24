-- A delegate whose runner disconnected (or whose heartbeats lapsed) no longer holds a slot, but its row is kept for a while so
-- that the cost the runner books later (a native subagent read from its transcript after a restart) is still known to be this
-- caller's. `delegate.cost` requires the row; the counting queries ignore a released one.
ALTER TABLE delegate_begins ADD COLUMN IF NOT EXISTS released_at timestamptz;
