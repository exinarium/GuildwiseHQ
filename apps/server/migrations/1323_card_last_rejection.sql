-- The latest runner rejection of a queued card ({reason, detail, kind?, repoId?}), shown by the board's workability
-- warning. Set by ClaimReleased(runner_rejected); cleared when a shift starts on the card, or (kind 'branch') when the
-- repository's working branch is set.
ALTER TABLE cards ADD COLUMN last_rejection jsonb;
