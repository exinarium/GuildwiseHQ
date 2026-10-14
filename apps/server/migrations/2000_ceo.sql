-- The CEO agent (docs/design/ceo-agent-v2.md section 9). Projection tables are rebuilt from the `Ceo*` events; the
-- operational ones (wakes, rate counters, memory TEXT) are not: a rebuild must neither lose a pending wake nor resurrect a
-- memory the owner told the CEO to forget. Operational tables carry no foreign key into a projection table, so a rebuild
-- (TRUNCATE ... CASCADE) leaves them alone.

-- Settings of the organization's CEO (one row per organization that ever had one).
CREATE TABLE ceo_settings (
  org_id             uuid PRIMARY KEY,
  agent_id           uuid,                          -- the active CEO agent (NULL once disabled)
  enabled            boolean NOT NULL DEFAULT true, -- false: disabled (the BA reports again)
  paused             boolean NOT NULL DEFAULT false,
  paused_reason      text,
  settings           jsonb NOT NULL,                -- CeoSettings
  policy             jsonb NOT NULL,                -- CeoPolicy
  policy_version     integer NOT NULL DEFAULT 1,
  training           jsonb NOT NULL,                -- CeoTraining
  chat_thread_id     uuid,
  report_day         text,                          -- local date of the last daily report (posted or queued)
  enabled_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL
);

-- One active CEO per organization (the `agents_one_devops` pattern).
CREATE UNIQUE INDEX agents_one_ceo ON agents (org_id) WHERE role_key = 'ceo' AND status <> 'retired';

-- The audit of everything the CEO did, recommended or was refused. `status`: done | recommended | refused | undone.
CREATE TABLE ceo_actions (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL,
  class            text NOT NULL,
  action           text NOT NULL,
  mode             text NOT NULL CHECK (mode IN ('decided','recommended','refused')),
  status           text NOT NULL CHECK (status IN ('done','recommended','refused','undone')),
  subject_kind     text NOT NULL DEFAULT '',
  subject_id       text NOT NULL DEFAULT '',
  subject_label    text NOT NULL DEFAULT '',
  params           jsonb NOT NULL DEFAULT '{}',
  reason           text NOT NULL DEFAULT '',
  confidence       real NOT NULL,
  evidence         jsonb NOT NULL DEFAULT '[]',
  policy_version   integer NOT NULL DEFAULT 0,
  verdict_reason   text NOT NULL DEFAULT '',
  cause            text,
  wake_batch_id    uuid,
  chat_thread_id   uuid,
  accepted_from    uuid,
  untrusted        boolean NOT NULL DEFAULT false,
  inverse          jsonb,
  idem_key         text NOT NULL,
  result           jsonb NOT NULL DEFAULT '{}',
  desk_item_id     uuid,
  -- recommendations: what the owner did with it (the training observation)
  response         text CHECK (response IN ('accepted','accepted_changed','rejected','different')),
  response_note    text,
  response_choice  text,
  responded_at     timestamptz,
  undone_at        timestamptz,
  undone_by        uuid,
  undo_kind        text,
  created_at       timestamptz NOT NULL,
  event_seq        bigint NOT NULL
);
CREATE UNIQUE INDEX ceo_actions_idem ON ceo_actions (org_id, idem_key);
CREATE INDEX ceo_actions_org_time ON ceo_actions (org_id, created_at DESC);
CREATE INDEX ceo_actions_subject ON ceo_actions (org_id, subject_kind, subject_id, created_at DESC);
CREATE INDEX ceo_actions_desk ON ceo_actions (desk_item_id) WHERE desk_item_id IS NOT NULL;

-- Tasks the owner gave the CEO.
CREATE TABLE ceo_tasks (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  title        text NOT NULL,
  request      text NOT NULL DEFAULT '',
  status       text NOT NULL CHECK (status IN ('open','in_progress','waiting_owner','waiting_work','done','failed','cancelled')),
  thread_id    uuid,
  due_at       timestamptz,
  watch        jsonb NOT NULL DEFAULT '[]',
  notes        jsonb NOT NULL DEFAULT '[]',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  done_at      timestamptz
);
CREATE INDEX ceo_tasks_org ON ceo_tasks (org_id, status, created_at DESC);

-- The owner's knowledge base. The TEXT is operational (ceo_memory_text): events carry ids and a hash only.
CREATE TABLE ceo_memories (
  id                 uuid PRIMARY KEY,
  org_id             uuid NOT NULL,
  kind               text NOT NULL,
  scope              text NOT NULL DEFAULT 'org',
  source             text NOT NULL,
  source_ref         text NOT NULL DEFAULT '',
  confidence         real NOT NULL,
  status             text NOT NULL CHECK (status IN ('active','candidate','retired','forgotten')),
  observations       integer NOT NULL DEFAULT 1,
  class              text,
  text_hash          text NOT NULL,
  created_at         timestamptz NOT NULL,
  last_confirmed_at  timestamptz,
  retired_reason     text NOT NULL DEFAULT ''
);
CREATE INDEX ceo_memories_org ON ceo_memories (org_id, status, created_at DESC);

CREATE TABLE ceo_memory_text (                     -- operational: physically deleted on "forget"
  memory_id   uuid PRIMARY KEY,
  org_id      uuid NOT NULL,
  text        text NOT NULL,
  quote       text NOT NULL DEFAULT '',
  search      tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED
);
CREATE INDEX ceo_memory_text_search ON ceo_memory_text USING gin (search);

-- Wakes waiting for a CEO shift (operational).
CREATE TABLE ceo_wakes (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        uuid NOT NULL,
  reason        text NOT NULL,
  urgency       text NOT NULL CHECK (urgency IN ('urgent','normal','scheduled')),
  subject_kind  text NOT NULL DEFAULT '',
  subject_id    text NOT NULL DEFAULT '',
  subject_label text NOT NULL DEFAULT '',
  detail        jsonb NOT NULL DEFAULT '{}',
  event_seq     bigint,
  untrusted     boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','taken','done','failed','dropped')),
  batch_id      uuid,
  attempts      integer NOT NULL DEFAULT 0,
  local_date    text,
  created_at    timestamptz NOT NULL,
  taken_at      timestamptz,
  done_at       timestamptz
);
CREATE INDEX ceo_wakes_pending ON ceo_wakes (org_id, status, created_at);
CREATE INDEX ceo_wakes_batch ON ceo_wakes (batch_id) WHERE batch_id IS NOT NULL;

-- The CEO's shifts (operational): which batch a shift works, to end and retry it.
CREATE TABLE ceo_batches (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL,
  agent_id    uuid NOT NULL,
  shift_id    uuid,
  purpose     text NOT NULL CHECK (purpose IN ('wake','review')),
  local_date  text,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts    integer NOT NULL DEFAULT 0,
  summary     text,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX ceo_batches_org ON ceo_batches (org_id, status);

-- Offline notices already sent (one e-mail and one desk notice per episode) and soft spend notices.
CREATE TABLE ceo_flags (
  org_id     uuid NOT NULL,
  flag       text NOT NULL,
  value      text NOT NULL,
  at         timestamptz NOT NULL,
  PRIMARY KEY (org_id, flag)
);

-- Shifts of the CEO have their own kind.
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_kind_check;
ALTER TABLE shifts ADD CONSTRAINT shifts_kind_check CHECK (kind IN ('card','chat','question','devops','ba_task','ceo'));
