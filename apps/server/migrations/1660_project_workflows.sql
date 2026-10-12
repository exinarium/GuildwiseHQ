-- More than one workflow per project (#10, docs/design/architect-and-workflows.md 4.1): the set a project has
-- enabled, one of them primary (= projects.workflow_key), each naming the card types it is the default for.
CREATE TABLE project_workflows (
  project_id          uuid NOT NULL REFERENCES projects(id),
  workflow_key        text NOT NULL,
  is_primary          boolean NOT NULL DEFAULT false,
  default_card_types  text[] NOT NULL DEFAULT '{}',
  enabled_at          timestamptz NOT NULL,
  PRIMARY KEY (project_id, workflow_key)
);
CREATE UNIQUE INDEX project_workflows_one_primary ON project_workflows (project_id) WHERE is_primary;

-- Migration path: every existing project has exactly its current workflow, as primary, with no explicit defaults.
INSERT INTO project_workflows (project_id, workflow_key, is_primary, default_card_types, enabled_at)
SELECT id, workflow_key, true, '{}', created_at FROM projects;

-- Project variants: workflow versions that belong to one project and extend a base workflow version.
ALTER TABLE workflow_versions
  ADD COLUMN project_id   uuid REFERENCES projects(id),
  ADD COLUMN base_key     text,
  ADD COLUMN base_version integer,
  ADD COLUMN variant_spec jsonb;
CREATE INDEX workflow_versions_project ON workflow_versions (project_id) WHERE project_id IS NOT NULL;
