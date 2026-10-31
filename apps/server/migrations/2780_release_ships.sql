-- Ship release, the release commit (release prep 3/4): one row per approved proposal (id = release_proposals.id).
CREATE TABLE IF NOT EXISTS release_ships (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL,
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_id             uuid NOT NULL REFERENCES project_repos(id) ON DELETE CASCADE,
  version             text NOT NULL,
  tag                 text NOT NULL,
  release_date        date NOT NULL,
  payload             jsonb NOT NULL,   -- the command payload without the commit identity (reloaded on send)
  status              text NOT NULL CHECK (status IN ('committing','committed','failed')),
  step                text,
  commit_sha          text,
  error               text,
  alert_desk_item_id  uuid,
  workstation_id      uuid,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  UNIQUE (repo_id, version)
);
