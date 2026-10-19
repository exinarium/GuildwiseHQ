-- Project graphs (docs/design/project-graphs.md sections 1, 5 and 13): STATUS only. The graph itself is derived from the
-- customer's code and lives in the project vault on the workstation; nothing code-derived is ever stored here. One row per
-- project repository: the commit that was indexed, counts, the indexer version and timings. A projection of the
-- ProjectGraph* events (rebuilt by `projections:rebuild`).
CREATE TABLE project_graphs (
  project_id      uuid NOT NULL REFERENCES projects(id),
  repo_id         uuid NOT NULL,
  repo_key        text NOT NULL,
  org_id          uuid NOT NULL,
  status          text NOT NULL CHECK (status IN ('requested','indexed','failed')),
  commit_id       text,
  files           integer NOT NULL DEFAULT 0,
  nodes           integer NOT NULL DEFAULT 0,
  edges           integer NOT NULL DEFAULT 0,
  modules         integer NOT NULL DEFAULT 0,
  indexer_version text,
  duration_ms     integer,
  workstation_id  uuid,
  vault_id        text,
  fail_reason     text,
  requested_at    timestamptz,
  indexed_at      timestamptz,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (project_id, repo_id)
);
CREATE INDEX project_graphs_org ON project_graphs (org_id);
