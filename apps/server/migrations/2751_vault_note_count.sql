-- How many notes a workstation's copy of a vault holds (runner-reported, best effort; NULL: not reported yet). Safe to run again.
ALTER TABLE workstation_vaults ADD COLUMN IF NOT EXISTS note_count integer;
