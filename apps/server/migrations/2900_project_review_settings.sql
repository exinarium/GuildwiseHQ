-- Per-project review settings (no defaults): the size budget, the unit it is measured in and the path-to-risk map.
-- Projection of ProjectReviewSettingsSet. All nullable with no DEFAULT and no backfill: unset stays unset.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS size_budget integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS size_unit text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS risk_map jsonb;
