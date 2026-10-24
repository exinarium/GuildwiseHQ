-- `aom delegate`, R2: the runner sends a heartbeat while a delegate runs, so a stuck slot is freed in seconds, and a row knows which
-- workstation runs it, so a runner that disconnects frees its delegates at once. Both columns are optional (an older runner sends none).
ALTER TABLE delegate_begins ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE delegate_begins ADD COLUMN IF NOT EXISTS workstation_id uuid;
