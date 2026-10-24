-- Organization-wide provider keys with a monthly spend cap per provider (docs/ARCHITECTURE.md section 38.5).
--
-- `org_providers` is a projection of the OrgProviderKey* / OrgProviderCap* events: which providers the organization holds a key for
-- (facts only) and the cap state. It has no foreign keys, like the other projection tables, so a rebuild can truncate it.
CREATE TABLE IF NOT EXISTS org_providers (
  org_id uuid NOT NULL,
  provider text NOT NULL,
  configured boolean NOT NULL DEFAULT false,
  detail text,
  base_url text,
  models jsonb NOT NULL DEFAULT '[]'::jsonb,
  set_by uuid,
  set_at timestamptz,
  cap_micros bigint,
  cap_set_by uuid,
  cap_set_at timestamptz,
  cap_warned_month text,
  cap_paused_month text,
  cap_override_month text,
  cap_desk_item_id uuid,
  PRIMARY KEY (org_id, provider)
);

-- The sealed copies of an organization key, one per workstation. NOT a projection and not part of any event: the server stores
-- only ciphertexts (sealed in the browser to the workstation's public key, or by another runner), relays them, and deletes them
-- on revocation. A copy is emptied once the runner stored it (`status = 'stored'`), so what stays is the fact that it is there.
CREATE TABLE IF NOT EXISTS org_provider_key_shares (
  org_id uuid NOT NULL,
  provider text NOT NULL,
  workstation_id uuid NOT NULL,
  key_id text NOT NULL,
  ciphertext text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'stored', 'failed')),
  error text,
  via text NOT NULL DEFAULT 'browser' CHECK (via IN ('browser', 'runner')),
  shared_by uuid,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider, workstation_id)
);
CREATE INDEX IF NOT EXISTS org_provider_key_shares_ws ON org_provider_key_shares (workstation_id);

-- Which key paid for a shift, session turn or delegate call: `org` (the organization's key, counted against its cap) or
-- `workstation` (the owner's own key, not counted). Null: no key (a subscription login).
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS key_source text;
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS key_provider text;
CREATE INDEX IF NOT EXISTS shift_costs_org_key ON shift_costs (org_id, key_provider, ended_at) WHERE key_source = 'org';
