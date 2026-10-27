-- Hire agents from a pack onto roles: the pack agent an agent works as, and the Owner's classification of a pack's skills.
-- Both are metadata only (the pack's text stays in the pack); both are projections of events and are rebuilt with them.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS pack_persona jsonb;
ALTER TABLE packs ADD COLUMN IF NOT EXISTS classification jsonb;
