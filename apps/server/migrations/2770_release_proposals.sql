-- Ship release proposal (release prep 2/4): the latest read of a repository by a workstation, and the proposals.
CREATE TABLE IF NOT EXISTS repo_release_facts (
  project_repo_id uuid PRIMARY KEY REFERENCES project_repos(id) ON DELETE CASCADE,
  request_id      uuid NOT NULL,
  workstation_id  uuid,
  trigger         text NOT NULL,
  state           text NOT NULL CHECK (state IN ('pending','ready','failed')),
  message         text,
  head_sha        text,
  facts           jsonb,
  requested_at    timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

-- Projection of the Release* events.
CREATE TABLE IF NOT EXISTS release_proposals (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL,
  project_id          uuid NOT NULL,
  repo_id             uuid NOT NULL,
  desk_item_id        uuid NOT NULL,
  state               text NOT NULL CHECK (state IN ('proposed','approved','dismissed','released','closed')),
  trigger             text NOT NULL,
  recommended_version text NOT NULL,
  recommended_level   text NOT NULL,
  reason              text NOT NULL,
  last_tag            text,
  head_sha            text NOT NULL,
  version             text,
  components          jsonb,
  notes               text,
  notes_source        text,
  approved_by         uuid,
  approved_at         timestamptz,
  closed_reason       text,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS release_proposals_one_live ON release_proposals (repo_id)
  WHERE state IN ('proposed','approved');
CREATE INDEX IF NOT EXISTS release_proposals_desk ON release_proposals (desk_item_id);
