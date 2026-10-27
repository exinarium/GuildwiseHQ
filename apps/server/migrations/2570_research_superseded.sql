-- A reopened research card's earlier note is superseded: kept for history, ignored by every listing and count.
ALTER TABLE research_publications ADD COLUMN superseded_at timestamptz;
CREATE INDEX research_publications_live ON research_publications (card_id) WHERE superseded_at IS NULL;
