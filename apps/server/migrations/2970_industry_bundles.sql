-- Industry bundles (business mode): which bundles an organization installed and what each created.
CREATE TABLE IF NOT EXISTS org_industry_bundles (
  org_id          uuid NOT NULL,
  bundle_id       text NOT NULL,
  bundle_version  integer NOT NULL,
  items           jsonb NOT NULL,
  installed_at    timestamptz NOT NULL,
  installed_by    uuid,
  removed_at      timestamptz,
  removed_by      uuid,
  PRIMARY KEY (org_id, bundle_id)
);

-- Industry bundles add document templates and sample data.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('brief','prd','minutes','session_log','file','template','sample'));
