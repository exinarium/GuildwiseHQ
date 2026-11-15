-- Needs split (projection of CardNeedsSplitRequested/Resolved): the latest record and how often the card went to the BA.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS needs_split jsonb;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS needs_split_count integer NOT NULL DEFAULT 0;
