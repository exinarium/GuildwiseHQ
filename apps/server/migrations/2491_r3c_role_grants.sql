-- R3c (docs/ARCHITECTURE.md section 38.11): delegation grants on a ROLE (Q61) and a model per grant (Q62). Projection state, rebuilt
-- from DelegateGrantChanged; additive. A role's grants cover every agent of the role in its organization, future hires included.
ALTER TABLE delegate_grants DROP CONSTRAINT IF EXISTS delegate_grants_owner_kind_check;
ALTER TABLE delegate_grants ADD CONSTRAINT delegate_grants_owner_kind_check CHECK (owner_kind IN ('agent','session','role'));
-- A role grant keeps its role key here (owner_id is a stable id derived from the organization and the key).
ALTER TABLE delegate_grants ADD COLUMN IF NOT EXISTS owner_key text;
-- The model the grant sets for its owner (Q62); both null: the target's own model.
ALTER TABLE delegate_grants ADD COLUMN IF NOT EXISTS model_runtime text;
ALTER TABLE delegate_grants ADD COLUMN IF NOT EXISTS model_name text;
ALTER TABLE delegate_grants ADD COLUMN IF NOT EXISTS model_effort text;
CREATE INDEX IF NOT EXISTS delegate_grants_role ON delegate_grants (org_id, owner_key) WHERE owner_kind = 'role';
