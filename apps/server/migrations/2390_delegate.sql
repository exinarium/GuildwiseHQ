-- `aom delegate` (Phase E): the cost of a nested delegate call is a `shift_costs` row of kind 'delegate' keyed by the
-- delegate id; `parent_id` is the caller (a session turn or a shift), so a session's meter counts it with its turns.
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS parent_id uuid;
CREATE INDEX IF NOT EXISTS shift_costs_parent ON shift_costs (parent_id) WHERE parent_id IS NOT NULL;
