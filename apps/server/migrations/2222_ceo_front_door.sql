-- The CEO as the owner's front door, step 1 (docs/design/ceo-front-door.md section 12). Projection tables, rebuilt from the
-- `Ceo*`, `Chat*` and `StandingOrder*` events. No foreign keys into other projection tables (a rebuild TRUNCATEs them).

-- A hidden per-order thread for the turns that enforce an Owner-authorized standing order.
ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_kind_check;
ALTER TABLE threads ADD CONSTRAINT threads_kind_check CHECK (kind IN ('card','chat','devops','intake','phase','ceo_order'));
-- The model switch (a thread-level choice, NULL: the default) and the extra working directories of a CEO conversation.
ALTER TABLE threads ADD COLUMN IF NOT EXISTS model_override jsonb;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS dirs text[] NOT NULL DEFAULT '{}';

-- Every owner or order turn of the CEO: persisted before it is sent, so a server restart loses nothing.
CREATE TABLE ceo_turns (
  id                  uuid PRIMARY KEY,                -- also the chat id and the shift id of the turn
  org_id              uuid NOT NULL,
  thread_id           uuid NOT NULL,
  message_id          uuid,                            -- the owner's message (NULL for an order turn)
  mode                text NOT NULL CHECK (mode IN ('owner','order')),
  status              text NOT NULL CHECK (status IN ('queued','running','done','failed','dropped')),
  queued              boolean NOT NULL DEFAULT false,  -- it waited for an offline workstation
  model               jsonb NOT NULL,                  -- ModelChoice
  workstation_id      uuid,
  order_entry_id      uuid,
  order_version_hash  text,
  order_wake_id       uuid,
  order_subject       text,
  order_why           text,
  order_outcome       text CHECK (order_outcome IN ('done','declined','failed')),
  order_summary       text,
  order_commands      jsonb NOT NULL DEFAULT '[]',
  order_ask           text,
  degraded            text,
  tool_counts         jsonb,
  error               text,
  queued_at           timestamptz NOT NULL,
  started_at          timestamptz,
  finished_at         timestamptz
);
CREATE INDEX ceo_turns_thread ON ceo_turns (thread_id, queued_at);
CREATE INDEX ceo_turns_org_status ON ceo_turns (org_id, status, queued_at);
CREATE INDEX ceo_turns_order ON ceo_turns (order_entry_id, queued_at) WHERE order_entry_id IS NOT NULL;

-- Questions "authorize this execution" raised by the permission relay of a turn.
CREATE TABLE ceo_permission_asks (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL,
  turn_id        uuid NOT NULL,
  thread_id      uuid,
  mode           text NOT NULL,
  tool           text NOT NULL,
  input          text NOT NULL DEFAULT '',
  reason         text NOT NULL DEFAULT '',
  desk_item_id   uuid NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','once','turn','deny','timeout')),
  asked_at       timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  answered_by    uuid,
  answered_at    timestamptz
);
CREATE INDEX ceo_permission_asks_turn ON ceo_permission_asks (turn_id);
CREATE INDEX ceo_permission_asks_org ON ceo_permission_asks (org_id, status, asked_at DESC);

-- What the CEO did itself instead of through the board, and the repeats detected in it.
CREATE TABLE ceo_offboard_jobs (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  turn_id       uuid,
  kind          text NOT NULL,
  title         text NOT NULL,
  summary       text NOT NULL DEFAULT '',
  project_id    uuid,
  cost_micros   bigint NOT NULL DEFAULT 0,
  duration_ms   bigint NOT NULL DEFAULT 0,
  auto          boolean NOT NULL DEFAULT false,
  first_token   text,
  created_at    timestamptz NOT NULL
);
CREATE INDEX ceo_offboard_jobs_kind ON ceo_offboard_jobs (org_id, kind, created_at DESC);

CREATE TABLE ceo_repeats (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  key             text NOT NULL,
  job_ids         uuid[] NOT NULL DEFAULT '{}',
  suggestion      text NOT NULL CHECK (suggestion IN ('feature','skill','automation')),
  count7          integer NOT NULL DEFAULT 0,
  count30         integer NOT NULL DEFAULT 0,
  project_id      uuid,
  detected_at     timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  decision        text,
  resolved_by     uuid,
  resolved_at     timestamptz,
  suppressed_until timestamptz,                         -- a dismissed repeat hides its key for 90 days
  reported_at     timestamptz                          -- the daily report that listed it
);
CREATE INDEX ceo_repeats_org ON ceo_repeats (org_id, status, detected_at DESC);
CREATE INDEX ceo_repeats_key ON ceo_repeats (org_id, key, detected_at DESC);

-- "You did X, I'd rather Y": one row per correction (the memory itself lives in ceo_memories).
CREATE TABLE ceo_corrections (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL,
  by_user_id       uuid NOT NULL,
  action_id        uuid,
  order_turn_id    uuid,
  chat_message_id  uuid,
  desk_item_id     uuid,
  thread_id        uuid,
  text             text NOT NULL,
  rule             text NOT NULL,
  memory_id        uuid,
  remedy           text NOT NULL DEFAULT 'none' CHECK (remedy IN ('none','undo','redo')),
  redo             jsonb,
  class            text,
  created_at       timestamptz NOT NULL,
  edited_at        timestamptz
);
CREATE INDEX ceo_corrections_org ON ceo_corrections (org_id, created_at DESC);
CREATE INDEX ceo_corrections_action ON ceo_corrections (action_id) WHERE action_id IS NOT NULL;
CREATE INDEX ceo_corrections_turn ON ceo_corrections (order_turn_id) WHERE order_turn_id IS NOT NULL;

-- The Owner's full-power mark on a standing order, pinned to the exact wording (sha256 of title and body).
CREATE TABLE standing_order_authority (
  entry_id        uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  version_hash    text,                                -- NULL: only escalated, never authorized
  scope           jsonb NOT NULL DEFAULT '{"projectIds":null}',
  covers          text[] NOT NULL DEFAULT '{}',
  authorized_by   uuid,
  authorized_at   timestamptz,
  voided_at       timestamptz,
  void_reason     text,
  revoked_at      timestamptz,
  revoked_by      uuid,
  escalated_by    uuid,                                -- an Admin asked the Owner to take the order over
  escalated_at    timestamptz,
  escalation_note text
);
CREATE INDEX standing_order_authority_org ON standing_order_authority (org_id);

-- Corrections rank first in every brief: the memory lookup by (org, kind, status).
CREATE INDEX IF NOT EXISTS ceo_memories_kind ON ceo_memories (org_id, kind, status);

-- Calls made inside an order turn name the order (and the pinned wording) they enforced; owner turns name the turn.
ALTER TABLE ceo_actions ADD COLUMN IF NOT EXISTS order_entry_id uuid;
ALTER TABLE ceo_actions ADD COLUMN IF NOT EXISTS order_version_hash text;
ALTER TABLE ceo_actions ADD COLUMN IF NOT EXISTS turn_id uuid;
