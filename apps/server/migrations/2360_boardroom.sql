-- Boardroom (phase C): the whiteboard, the rounds, the recorded disagreements, the decision points and the saved rooms.
-- Projection tables rebuilt from the `Board*` events (no foreign keys into other projection tables: a rebuild TRUNCATEs them).

-- Sticky notes of the whiteboard. `votes` holds the ids of the people who gave +1.
CREATE TABLE IF NOT EXISTS board_notes (
  id          uuid PRIMARY KEY,
  thread_id   uuid NOT NULL,
  org_id      uuid NOT NULL,
  seq         bigint NOT NULL,
  col         text NOT NULL CHECK (col IN ('ideas','risks','questions','decisions','parked')),
  text        text NOT NULL,
  by_kind     text NOT NULL,
  by_name     text NOT NULL,
  by_id       text,
  round       int,
  turn_id     uuid,
  votes       text[] NOT NULL DEFAULT '{}',
  merged_from jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  removed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS board_notes_thread ON board_notes (thread_id, seq);

-- One row per planned round: who speaks and why.
CREATE TABLE IF NOT EXISTS board_rounds (
  thread_id   uuid NOT NULL,
  round       int NOT NULL,
  org_id      uuid NOT NULL,
  seq         bigint NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('independent','discussion','dissent')),
  speakers    jsonb NOT NULL,
  reason      text NOT NULL DEFAULT '',
  instruction text NOT NULL DEFAULT '',
  source      text NOT NULL,
  planned_at  timestamptz NOT NULL,
  PRIMARY KEY (thread_id, round)
);

-- Disagreements are recorded, never reconciled.
CREATE TABLE IF NOT EXISTS board_disagreements (
  id          uuid PRIMARY KEY,
  thread_id   uuid NOT NULL,
  org_id      uuid NOT NULL,
  seq         bigint NOT NULL,
  topic       text NOT NULL,
  positions   jsonb NOT NULL,
  round       int,
  by_name     text NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS board_disagreements_thread ON board_disagreements (thread_id, seq);

-- Decision points: the Chair stopped, the owner decides.
CREATE TABLE IF NOT EXISTS board_decisions (
  id             uuid PRIMARY KEY,
  thread_id      uuid NOT NULL,
  org_id         uuid NOT NULL,
  seq            bigint NOT NULL,
  question       text NOT NULL,
  options        jsonb NOT NULL DEFAULT '[]',
  round          int,
  status         text NOT NULL CHECK (status IN ('open','resolved','withdrawn')),
  answer         text,
  option_id      text,
  asked_by_name  text NOT NULL,
  asked_at       timestamptz NOT NULL,
  resolved_at    timestamptz
);
CREATE INDEX IF NOT EXISTS board_decisions_thread ON board_decisions (thread_id, seq);

-- Saved casts ("rooms") of an organization.
CREATE TABLE IF NOT EXISTS board_rooms (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL,
  name        text NOT NULL,
  format      text NOT NULL,
  round_cap   int NOT NULL,
  members     jsonb NOT NULL,
  models      jsonb NOT NULL DEFAULT '{}',
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL,
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS board_rooms_org ON board_rooms (org_id, created_at);
