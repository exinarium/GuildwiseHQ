-- How many shifts a workstation runs at once, chosen by its owner on the Workstations page (backlog #76).
-- Both NULL/false: none chosen, the runner's own maxConcurrentShifts applies. Projection of WorkstationShiftLimitSet.
ALTER TABLE workstations
  ADD COLUMN shift_limit           integer CHECK (shift_limit IS NULL OR shift_limit >= 1),
  ADD COLUMN shift_limit_unlimited boolean NOT NULL DEFAULT false;
