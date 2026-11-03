-- Journeys (release 1.5.0): one organisational process from trigger to outcome, made of workflows linked by handoffs,
-- all working on one shared record. A journey step runs a workflow as a card (origin 'journey').
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_origin_check;
ALTER TABLE cards ADD CONSTRAINT cards_origin_check
  CHECK (origin IN ('manual','intake','schedule','test_failure','full_suite','regression','interest',
                    'subworkflow','trigger','email','journey'));

CREATE TABLE journeys (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES projects(id),
  name            text NOT NULL,
  record_type     text NOT NULL CHECK (record_type IN ('client','matter','deal')),
  current_version integer NOT NULL,
  status          text NOT NULL CHECK (status IN ('active','archived')),
  created_by      uuid,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX journeys_project ON journeys (project_id, status);

CREATE TABLE journey_versions (
  journey_id uuid NOT NULL REFERENCES journeys(id),
  version    integer NOT NULL,
  definition jsonb NOT NULL,
  saved_by   uuid,
  saved_at   timestamptz NOT NULL,
  PRIMARY KEY (journey_id, version)
);

-- The shared record: status, step, timestamps and references only (owner decision 5). No answers, no content.
CREATE TABLE journey_records (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL,
  project_id          uuid NOT NULL REFERENCES projects(id),
  record_type         text NOT NULL CHECK (record_type IN ('client','matter','deal')),
  external_id         text,
  display_name        text NOT NULL,
  status              text NOT NULL CHECK (status IN ('active','closed')),
  current_instance_id uuid,
  current_step_id     text,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);
CREATE INDEX journey_records_project ON journey_records (project_id, record_type);

CREATE TABLE journey_record_refs (
  record_id uuid NOT NULL REFERENCES journey_records(id),
  kind      text NOT NULL CHECK (kind IN ('document','form_submission','card','playbook_session')),
  ref       text NOT NULL,
  label     text,
  added_at  timestamptz NOT NULL,
  PRIMARY KEY (record_id, kind, ref)
);

CREATE TABLE journey_instances (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES projects(id),
  journey_id      uuid NOT NULL REFERENCES journeys(id),
  journey_version integer NOT NULL,
  record_id       uuid NOT NULL REFERENCES journey_records(id),
  status          text NOT NULL CHECK (status IN ('running','waiting','stuck','completed','cancelled')),
  current_visit   integer NOT NULL,
  current_step_id text NOT NULL,
  started_by      uuid NOT NULL,
  started_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  ended_at        timestamptz
);
CREATE INDEX journey_instances_list ON journey_instances (project_id, status, current_step_id);
CREATE INDEX journey_instances_record ON journey_instances (record_id);

-- One row per visit of a step: the history and the dedupe key of the runtime.
-- pending: entered, card not yet created. open: card running. waiting: placeholder. done/cancelled/skipped: ended.
-- refused: could not start (a desk alert is open).
CREATE TABLE journey_step_runs (
  instance_id        uuid NOT NULL REFERENCES journey_instances(id),
  visit              integer NOT NULL,
  step_id            text NOT NULL,
  handoff_id         text,
  from_visit         integer,
  status             text NOT NULL CHECK (status IN ('pending','open','waiting','done','cancelled','skipped','refused')),
  card_id            uuid UNIQUE REFERENCES cards(id),
  playbook_thread_id uuid,
  desk_item_id       uuid,
  entered_at         timestamptz NOT NULL,
  started_at         timestamptz,
  ended_at           timestamptz,
  PRIMARY KEY (instance_id, visit)
);
CREATE INDEX journey_step_runs_pending ON journey_step_runs (instance_id) WHERE status = 'pending';
CREATE INDEX journey_step_runs_open ON journey_step_runs (card_id) WHERE status = 'open';
CREATE INDEX journey_step_runs_refused ON journey_step_runs (desk_item_id) WHERE status = 'refused';
