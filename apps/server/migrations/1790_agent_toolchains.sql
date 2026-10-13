-- Agent toolchains (docs/RUNNER.md "Agent toolchains").
-- workstations.toolchains: what the runner reports on each `toolchains.report` (operational, replaced on every report, kept
-- over a projection rebuild): [{name, source, version?, binDirs, readDirs, envKeys, addedAt?, addedBy?}]. Folder paths and
-- variable names only, never a value.
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS toolchains            jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS toolchains_checked_at timestamptz;
