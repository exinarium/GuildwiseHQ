-- Discovery Studio and Boardroom, step 1 (docs/design/discovery-boardroom-registry.md): multi-participant session threads
-- and their durable turns. Projection tables, rebuilt from the `Session*` and `ThreadParticipant*` events. No foreign keys
-- into other projection tables (a rebuild TRUNCATEs them).

-- Two new thread kinds. Existing kinds and rows are untouched.
ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_kind_check;
ALTER TABLE threads ADD CONSTRAINT threads_kind_check
  CHECK (kind IN ('card','chat','devops','intake','phase','ceo_order','discovery','boardroom'));
-- Where a session's turns run, and the facilitator's state (phase, stance, time box). `agent_id` is the host agent.
ALTER TABLE threads ADD COLUMN IF NOT EXISTS workstation_id uuid;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS session_config jsonb NOT NULL DEFAULT '{}';

-- A persona speaks as `author_kind = 'agent'` with no agent row, so every query on agent messages keeps working.
ALTER TABLE thread_messages ADD COLUMN IF NOT EXISTS author_persona_key text;

CREATE TABLE IF NOT EXISTS thread_participants (
  id           uuid PRIMARY KEY,
  thread_id    uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('user','agent','persona')),
  ref_id       text NOT NULL,                  -- user id, agent id or persona key
  seat         text NOT NULL,
  stance       text,
  display_name text NOT NULL,
  added_at     timestamptz NOT NULL,
  removed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS thread_participants_thread ON thread_participants (thread_id, added_at);
CREATE INDEX IF NOT EXISTS thread_participants_user ON thread_participants (ref_id) WHERE kind = 'user' AND removed_at IS NULL;

-- Every turn of a session: persisted before it is sent, so a restart of the server or an offline workstation loses nothing.
CREATE TABLE IF NOT EXISTS session_turns (
  id                  uuid PRIMARY KEY,         -- also the chat id the runner knows the turn by
  org_id              uuid NOT NULL,
  thread_id           uuid NOT NULL,
  participant_id      uuid,
  speaker_kind        text NOT NULL CHECK (speaker_kind IN ('agent','persona')),
  speaker_name        text NOT NULL,
  agent_id            uuid,
  persona_key         text,
  seat                text,
  instructions        text,
  message             text NOT NULL,
  context             jsonb NOT NULL DEFAULT '{}',
  model               jsonb NOT NULL,
  workstation_id      uuid,
  status              text NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts            int NOT NULL DEFAULT 0,
  round               int,
  reply_to_message_id uuid,
  message_id          uuid,                     -- the stored reply
  usage               jsonb,
  runtime_session_id  text,
  error               text,
  requested_by        uuid,
  queued_at           timestamptz NOT NULL,
  started_at          timestamptz,
  finished_at         timestamptz
);
CREATE INDEX IF NOT EXISTS session_turns_thread ON session_turns (thread_id, queued_at);
CREATE INDEX IF NOT EXISTS session_turns_open ON session_turns (status, queued_at) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS session_turns_workstation ON session_turns (workstation_id, status) WHERE status IN ('queued','running');
