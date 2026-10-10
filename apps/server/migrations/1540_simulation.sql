-- Simulation organizations (docs/design/open-questions-2026-10-10-simulation.md): a flag, a pace, and the one exception
-- to the append-only event log.

ALTER TABLE organizations ADD COLUMN simulation boolean NOT NULL DEFAULT false;
-- How fast the simulated workstation works: fast | normal | slow (super admin setting).
ALTER TABLE organizations ADD COLUMN simulation_pace text NOT NULL DEFAULT 'normal'
  CHECK (simulation_pace IN ('fast','normal','slow'));

-- The event log stays append-only. The single exception: while wiping a simulation organization the server sets
-- `aom.simulation_wipe = 'on'` and `aom.wipe_org = <org id>` for the transaction; deletes are then allowed, but only when
-- that organization exists and is flagged `simulation`. Updates are never allowed.
CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('aom.simulation_wipe', true) = 'on'
     AND EXISTS (SELECT 1 FROM organizations
                  WHERE id::text = current_setting('aom.wipe_org', true) AND simulation) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'events is append-only';
END $$;
