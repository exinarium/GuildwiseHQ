CREATE TABLE shifts (
  id                 uuid PRIMARY KEY,
  org_id             uuid NOT NULL REFERENCES users(id),
  agent_id           uuid NOT NULL REFERENCES agents(id),
  workstation_id     uuid NOT NULL REFERENCES workstations(id),
  card_id            uuid REFERENCES cards(id),
  kind               text NOT NULL CHECK (kind IN ('card','chat','question','devops')),
  stage              text,
  status             text NOT NULL CHECK (status IN ('starting','running','ended')),
  outcome            text,              -- reported | no_report | stopped | crashed | timeout | rejected | lost
  report_outcome     text,              -- stage outcome id reported via aom
  runtime            text NOT NULL,
  model              text NOT NULL,
  runtime_session_id text,
  overflow           boolean NOT NULL DEFAULT false,
  started_at         timestamptz NOT NULL,
  ended_at           timestamptz,
  duration_ms        integer,
  tokens_input       bigint, tokens_output bigint, tokens_cache_read bigint, tokens_cache_write bigint,
  progress_tail      jsonb NOT NULL DEFAULT '[]',  -- operational: last 50 progress items
  accepted_at        timestamptz                   -- operational: runner shift.accepted received
);
CREATE INDEX shifts_agent ON shifts (agent_id, started_at DESC);
CREATE INDEX shifts_card  ON shifts (card_id, started_at);

CREATE TABLE threads (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES users(id),
  project_id uuid REFERENCES projects(id),
  card_id    uuid REFERENCES cards(id),
  kind       text NOT NULL CHECK (kind IN ('card','chat','devops','intake')),
  agent_id   uuid REFERENCES agents(id),    -- chat/devops counterpart
  title      text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX threads_one_per_card ON threads (card_id) WHERE kind = 'card';

CREATE TABLE thread_messages (
  id              uuid PRIMARY KEY,
  thread_id       uuid NOT NULL REFERENCES threads(id),
  author_kind     text NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_user_id  uuid REFERENCES users(id),
  author_agent_id uuid REFERENCES agents(id),
  kind            text NOT NULL CHECK (kind IN ('comment','question','answer','handoff','review','evidence','chat','system')),
  body            text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}',
  event_seq       bigint NOT NULL,
  created_at      timestamptz NOT NULL
);
CREATE INDEX thread_messages_thread ON thread_messages (thread_id, created_at);
