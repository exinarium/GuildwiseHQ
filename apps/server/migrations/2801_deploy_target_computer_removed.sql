-- The computer that deploys a place (deploy target) was unpaired: the place keeps its `workstation_id` for the record and
-- carries this mark until the Owner chooses another computer for it (`DeployTargetComputerRemoved`, cleared by
-- `DeployTargetUpdated` with a new `workstationId` or by `DeployTargetConnected`).
ALTER TABLE deploy_targets ADD COLUMN IF NOT EXISTS computer_removed_at timestamptz;
