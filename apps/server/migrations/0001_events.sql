CREATE TABLE events (
  seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id              uuid        NOT NULL DEFAULT uuidv7() UNIQUE,
  stream_id       text        NOT NULL,
  stream_version  integer     NOT NULL,
  type            text        NOT NULL,
  schema_version  smallint    NOT NULL DEFAULT 1,
  payload         jsonb       NOT NULL,
  actor_kind      text        NOT NULL CHECK (actor_kind IN ('user','agent','system','runner')),
  actor_id        uuid,
  org_id          uuid,
  project_id      uuid,
  audience        text        NOT NULL CHECK (audience IN ('org','project','admin','system')),
  correlation_id  uuid,
  causation_id    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stream_id, stream_version)
);
CREATE INDEX events_org_seq     ON events (org_id, seq);
CREATE INDEX events_project_seq ON events (project_id, seq) WHERE project_id IS NOT NULL;
CREATE INDEX events_type_seq    ON events (type, seq);

CREATE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'events is append-only'; END $$;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
