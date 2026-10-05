-- Loop breaker (docs/design/phases.md B0): a card whose shifts keep failing is held back from the dispatcher.
-- Projected from CardRetryDeferred / CardRetryReleased; reset by a written handoff or a manager move.
ALTER TABLE cards
  ADD COLUMN retry_after      timestamptz,                 -- not dispatched before this time
  ADD COLUMN retry_failures   integer NOT NULL DEFAULT 0,  -- failed shifts of the current episode (0 = no episode)
  ADD COLUMN retry_episode_id uuid;
