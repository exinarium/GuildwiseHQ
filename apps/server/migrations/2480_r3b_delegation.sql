-- Revision R3b (docs/ARCHITECTURE.md section 38.9): explicit delegation. Projection state, rebuilt from DelegateGrantChanged and
-- DelegateCompleted; additive (older rows keep their defaults). Delegation is off by default: no grant row, no delegation.

-- A grant lets an owner (an agent, or the facilitator and Chair of one session) delegate to one target (a persona or a hired agent).
-- Nothing is migrated into this table: every existing agent and session starts with no grants.
CREATE TABLE IF NOT EXISTS delegate_grants (
  owner_kind   text NOT NULL CHECK (owner_kind IN ('agent','session')),
  owner_id     uuid NOT NULL,
  org_id       uuid NOT NULL,
  target_kind  text NOT NULL CHECK (target_kind IN ('persona','agent')),
  target_key   text NOT NULL,
  max_calls    integer NOT NULL DEFAULT 4,
  timeout_sec  integer NOT NULL DEFAULT 110,
  max_profile  text CHECK (max_profile IN ('read_only','edit','shell')),
  granted_by   uuid,
  granted_at   timestamptz NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, target_kind, target_key)
);
CREATE INDEX IF NOT EXISTS delegate_grants_org ON delegate_grants (org_id);
CREATE INDEX IF NOT EXISTS delegate_grants_target ON delegate_grants (target_kind, target_key);

-- What a running child is: the per-target count and the live cap stop read these.
ALTER TABLE delegate_begins ADD COLUMN IF NOT EXISTS target text;
ALTER TABLE delegate_begins ADD COLUMN IF NOT EXISTS target_kind text;
ALTER TABLE delegate_begins ADD COLUMN IF NOT EXISTS target_name text;
ALTER TABLE delegate_begins ADD COLUMN IF NOT EXISTS runtime text;
ALTER TABLE delegate_begins ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE delegate_begins ADD COLUMN IF NOT EXISTS profile text;
ALTER TABLE delegate_begins ADD COLUMN IF NOT EXISTS native boolean NOT NULL DEFAULT false;
ALTER TABLE delegate_begins ADD COLUMN IF NOT EXISTS caller_kind text;

-- The sub-step a finished delegation shows on its card or session (a `shift_costs` row of kind 'delegate').
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS delegate_target text;
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS delegate_target_name text;
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS delegate_target_kind text;
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS delegate_profile text;
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS delegate_outcome text;
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS delegate_duration_ms integer;
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS delegate_summary text;
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS delegate_native boolean NOT NULL DEFAULT false;
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS delegate_thread_id uuid;
CREATE INDEX IF NOT EXISTS shift_costs_delegate_thread ON shift_costs (delegate_thread_id) WHERE kind = 'delegate';
