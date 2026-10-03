CREATE TABLE workflow_versions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid REFERENCES users(id),           -- NULL = built-in
  key         text NOT NULL,
  version     integer NOT NULL,
  name        text NOT NULL,
  department  text,
  definition  jsonb NOT NULL,                       -- WorkflowDefinition (shared/workflows/schema.ts)
  status      text NOT NULL CHECK (status IN ('draft','pending_approval','active','superseded','rejected')),
  created_at  timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (org_id, key, version)
);
CREATE TABLE workflow_stages (                     -- flattened for dispatcher joins
  workflow_version_id uuid NOT NULL REFERENCES workflow_versions(id),
  stage_id            text NOT NULL,
  ordinal             smallint NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('agent','manual','terminal')),
  claim_role          text,                          -- role key; NULL for manual/terminal
  senior_only         boolean NOT NULL DEFAULT false,
  column_key          text NOT NULL,
  PRIMARY KEY (workflow_version_id, stage_id)
);
CREATE TABLE role_definitions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid REFERENCES users(id),           -- NULL = built-in
  key         text NOT NULL,
  version     integer NOT NULL,
  definition  jsonb NOT NULL,                       -- RoleDefinition
  status      text NOT NULL CHECK (status IN ('draft','pending_approval','active','superseded','rejected')),
  created_at  timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (org_id, key, version)
);
CREATE TABLE role_extensions (                     -- owner's additions to a built-in role (M9/M10; table in M1)
  org_id       uuid NOT NULL REFERENCES users(id),
  role_key     text NOT NULL,
  base_version integer NOT NULL,
  extensions   jsonb NOT NULL,                      -- {instructions, skills[], standingOrders[]}
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (org_id, role_key)
);
