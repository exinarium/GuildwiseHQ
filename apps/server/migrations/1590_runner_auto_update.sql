-- Runner self-update (docs/RUNNER.md "Updates"): what the runner last said about updating itself, shown on the
-- Workstations page. Set by the runner gateway from the `runner.update` message; operational, not rebuilt from events.
-- The kill switch lives in platform_settings under 'runners.auto_update_paused'. Safe to run again.
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS runner_update jsonb;
