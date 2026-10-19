-- Project graphs, measurement (docs/design/project-graphs.md section 11). One row per measured card shift: how many billed
-- input tokens it used and what it took to find its way in the code (bytes and calls of the search tools before the first
-- edit, bytes and calls of `aom graph`, the size of the graph section). Numbers only: nothing names a file or a symbol.
-- A projection of the ShiftContextMeasured events (a rebuild reproduces every row). `graph_arm`: 'on' had the graph, 'off'
-- is the holdout; shifts of a project without a graph are not stored.
CREATE TABLE shift_context_metrics (
  shift_id             uuid PRIMARY KEY,
  org_id               uuid NOT NULL,
  project_id           uuid NOT NULL,
  card_id              uuid NOT NULL,
  graph_arm            text NOT NULL CHECK (graph_arm IN ('on','off')),
  billed_input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens        bigint NOT NULL DEFAULT 0,
  discovery_bytes      bigint NOT NULL DEFAULT 0,
  discovery_calls      integer NOT NULL DEFAULT 0,
  graph_bytes          bigint NOT NULL DEFAULT 0,
  graph_calls          integer NOT NULL DEFAULT 0,
  brief_bytes          integer NOT NULL DEFAULT 0,
  measured_at          timestamptz NOT NULL
);
CREATE INDEX shift_context_metrics_card ON shift_context_metrics (card_id);
CREATE INDEX shift_context_metrics_org_project ON shift_context_metrics (org_id, project_id, measured_at);
