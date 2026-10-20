-- Delivery recipes, operational tables (not rebuilt from events; step 2 of docs/design/ceo-front-door.md).

-- Which recipe secrets a workstation holds, by NAME and time only: the values are sealed in the browser for the runner.
CREATE TABLE deploy_secret_status (
  -- no foreign keys: a projection rebuild truncates workstations and projects with CASCADE and must not take this along
  workstation_id uuid NOT NULL,
  project_id     uuid NOT NULL,
  name           text NOT NULL,
  set_at         timestamptz NOT NULL,
  set_by         uuid,
  PRIMARY KEY (workstation_id, project_id, name)
);

-- Merges wait here for two minutes so that a burst of merges deploys once (the newest commit wins).
CREATE TABLE deploy_trigger_queue (
  project_id uuid NOT NULL,
  trigger    text NOT NULL CHECK (trigger IN ('after_merge','phase_done')),
  commit     text,
  due_at     timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, trigger)
);
