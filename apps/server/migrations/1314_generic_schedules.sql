-- Generic schedules (docs/design/restructure.md Part B): a trigger (cron, manual, an internal event, a labelled issue) and
-- one action (card, regression, DevOps request, BA task, integration). Projection of the Schedule* events: a rebuild
-- reproduces every column below from the events (`action` and `trigger` are derived from `kind` + `card_template` for
-- events written before this migration).
ALTER TABLE schedules ALTER COLUMN project_id DROP NOT NULL;   -- organization-level actions
ALTER TABLE schedules ALTER COLUMN cron DROP NOT NULL;         -- manual and event triggers have none
ALTER TABLE schedules ALTER COLUMN timezone DROP NOT NULL;
ALTER TABLE schedules ALTER COLUMN card_template DROP NOT NULL; -- only create_card and regression_run have one
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS trigger        jsonb;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS action         jsonb;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS owner_user_id  uuid REFERENCES users(id);
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_status    text;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_summary   text;
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_kind_check;
ALTER TABLE schedules ADD CONSTRAINT schedules_kind_check
  CHECK (kind IN ('feed','regression','card','devops_request','ba_task','integration'));
-- Old rows read as create_card (feed, card) or regression_run, on a cron trigger. Only rows without an action, so
-- running this file again never overwrites a trigger or action someone set later.
UPDATE schedules SET
    action = CASE kind
      WHEN 'regression' THEN jsonb_build_object('kind','regression_run','projectId',project_id,'template',card_template)
      ELSE jsonb_build_object('kind','create_card','projectId',project_id,'template',card_template) END,
    trigger = jsonb_build_object('kind','cron','cron',cron,'timezone',timezone)
  WHERE action IS NULL;
-- The due query serves cron and labelled-issue triggers only.
DROP INDEX IF EXISTS schedules_due;
CREATE INDEX schedules_due ON schedules (next_fire_at) WHERE enabled AND next_fire_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS schedules_org ON schedules (org_id);

-- The run history. A run is one execution of the action: a cron fire, "Run now", an event, a polled issue, a webhook
-- test. Deliveries (webhook, e-mail) keep what they send, so a retry sends exactly what the first try did.
CREATE TABLE IF NOT EXISTS schedule_runs (
  id              uuid PRIMARY KEY,
  schedule_id     uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL,
  trigger         text NOT NULL CHECK (trigger IN ('cron','manual','event','issue','test')),
  source_key      text,
  label           text,
  status          text NOT NULL CHECK (status IN ('ok','failed','pending')),
  summary         text NOT NULL DEFAULT '',
  error           text,
  result          jsonb,
  delivery        jsonb,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS schedule_runs_schedule ON schedule_runs (schedule_id, started_at DESC);
CREATE INDEX IF NOT EXISTS schedule_runs_due ON schedule_runs (next_attempt_at) WHERE status = 'pending' AND delivery IS NOT NULL;
-- A source (an event, a polled issue) runs a schedule once.
CREATE UNIQUE INDEX IF NOT EXISTS schedule_runs_source ON schedule_runs (schedule_id, source_key) WHERE source_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS schedule_attempts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       uuid NOT NULL REFERENCES schedule_runs(id) ON DELETE CASCADE,
  schedule_id  uuid NOT NULL,
  attempt      integer NOT NULL,
  at           timestamptz NOT NULL,
  ok           boolean NOT NULL,
  http_status  integer,
  error        text,
  duration_ms  integer
);
CREATE INDEX IF NOT EXISTS schedule_attempts_run ON schedule_attempts (run_id, attempt);

-- Where the event-trigger sweep has read up to (operational: not a projection, kept across a rebuild). Absent: the
-- sweep starts at the current end of the log, so a new deployment never replays history into schedules.
CREATE TABLE IF NOT EXISTS schedule_trigger_cursor (
  id       integer PRIMARY KEY CHECK (id = 1),
  last_seq bigint NOT NULL
);

-- BA tasks asked for by a schedule (kind 'scheduled_brief': free-text instructions, answered with one report).
ALTER TABLE ba_tasks DROP CONSTRAINT IF EXISTS ba_tasks_kind_check;
ALTER TABLE ba_tasks ADD CONSTRAINT ba_tasks_kind_check CHECK (kind IN
  ('phase_report','followups_brief','followup_custom','followups_report',
   'desk_triage','urgent_note','floor_alert','floor_report','scheduled_brief'));
ALTER TABLE ba_tasks ADD COLUMN IF NOT EXISTS instructions   text;
ALTER TABLE ba_tasks ADD COLUMN IF NOT EXISTS deliver        text;
ALTER TABLE ba_tasks ADD COLUMN IF NOT EXISTS schedule_id    uuid;
ALTER TABLE ba_tasks ADD COLUMN IF NOT EXISTS schedule_name  text;
-- An organization-level task is filed under a carrier project but reads and reports for the whole organization.
ALTER TABLE ba_tasks ADD COLUMN IF NOT EXISTS org_level      boolean NOT NULL DEFAULT false;

-- The issues a polling schedule has already taken (GitHub or Jira): each issue runs the schedule once.
CREATE TABLE IF NOT EXISTS schedule_issues (
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  issue_key   text NOT NULL,
  run_id      uuid,
  seen_at     timestamptz NOT NULL,
  PRIMARY KEY (schedule_id, issue_key)
);
