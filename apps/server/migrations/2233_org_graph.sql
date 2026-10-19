-- Project graphs, the organization graph (docs/design/project-graphs.md section 8). Only the links the Owner ASSERTED are
-- here: an endpoint is a project id or a name the Owner typed, never anything derived from code. The links derived from the
-- code of several projects are code-derived: they stay in the organization vault on the workstation (`org/graph/`) and the
-- CEO shows them in chat. A projection of OrgGraphLinkAsserted / OrgGraphLinkRetracted (a rebuild reproduces every row).
CREATE TABLE org_graph_links (
  link_id         uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('depends_on','uses','related')),
  from_project_id uuid,
  from_name       text,
  to_project_id   uuid,
  to_name         text,
  note            text,
  origin          text NOT NULL DEFAULT 'owner' CHECK (origin IN ('owner','accepted-draft')),
  asserted_by     uuid NOT NULL,
  asserted_at     timestamptz NOT NULL,
  retracted_at    timestamptz,
  CHECK ((from_project_id IS NOT NULL) <> (from_name IS NOT NULL)),
  CHECK ((to_project_id IS NOT NULL) <> (to_name IS NOT NULL))
);
CREATE INDEX org_graph_links_org ON org_graph_links (org_id) WHERE retracted_at IS NULL;
