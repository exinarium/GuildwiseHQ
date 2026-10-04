-- Organization designer (M10): departments, and the bookkeeping of custom role / workflow versions.
CREATE TABLE departments (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES users(id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX departments_org_name ON departments (org_id, lower(name));

ALTER TABLE role_definitions
  ADD COLUMN department      text,
  ADD COLUMN desk_item_id    uuid,
  ADD COLUMN drafted_by_kind text,
  ADD COLUMN vault_path      text;
ALTER TABLE workflow_versions
  ADD COLUMN desk_item_id    uuid,
  ADD COLUMN drafted_by_kind text,
  ADD COLUMN vault_path      text;

CREATE INDEX role_definitions_org_key ON role_definitions (org_id, key);
CREATE INDEX workflow_versions_org_key ON workflow_versions (org_id, key);
