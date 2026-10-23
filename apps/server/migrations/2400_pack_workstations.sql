-- Capability packs, review fixes: a pack is held only by the workstations the adding admin chose (empty: the admin's own), and an
-- integrity failure is a fact about one workstation, not about the whole organization. Projection state, rebuilt from the Pack* events.
ALTER TABLE packs ADD COLUMN IF NOT EXISTS workstation_ids uuid[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS pack_workstation_state (
  pack_id           uuid NOT NULL,
  workstation_id    uuid NOT NULL,
  integrity_failed  boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL,
  PRIMARY KEY (pack_id, workstation_id)
);
