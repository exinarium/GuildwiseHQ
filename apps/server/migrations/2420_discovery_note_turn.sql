-- A panel note remembers the session turn that added it, so the CEO's one-opinion-per-turn limit counts per turn instead of
-- over the last minute of the wall clock. Projection column, rebuilt from DiscoveryNoteAdded (older events have no turn).
ALTER TABLE discovery_notes ADD COLUMN IF NOT EXISTS turn_id uuid;
CREATE INDEX IF NOT EXISTS discovery_notes_turn ON discovery_notes (turn_id) WHERE turn_id IS NOT NULL;
