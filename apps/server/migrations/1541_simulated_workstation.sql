-- The simulated workstation of a simulation organization (hosted by the Guildwise server): the workstation row says
-- which simulation organization it serves. Set by `WorkstationPaired.simulationOrgId`; NULL for every real workstation.
ALTER TABLE workstations ADD COLUMN simulation_org_id uuid;
CREATE INDEX workstations_simulation_org ON workstations (simulation_org_id) WHERE simulation_org_id IS NOT NULL;
