-- Owner-set prices for models the built-in tables do not price (R2). A projection of OrgModelPriceSet / OrgModelPriceRemoved.
CREATE TABLE IF NOT EXISTS org_model_prices (
  org_id uuid NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  input_per_mtok numeric NOT NULL,
  output_per_mtok numeric NOT NULL,
  cache_read_per_mtok numeric,
  set_by uuid,
  set_at timestamptz,
  PRIMARY KEY (org_id, provider, model)
);
-- A cost row whose price was the Owner's (shown as such; counted as priced, not unknown).
ALTER TABLE shift_costs ADD COLUMN IF NOT EXISTS owner_priced boolean NOT NULL DEFAULT false;
