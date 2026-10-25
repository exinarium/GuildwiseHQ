-- The people of a session room are listed in the order they were added. Several are added by events that share one
-- timestamp, and the id (a random uuid) then decided the order: the seats of a boardroom came out shuffled. `ord` is the
-- insertion order (the projection applies the events in order, so a rebuild gives the same one).
ALTER TABLE thread_participants ADD COLUMN IF NOT EXISTS ord bigserial;
