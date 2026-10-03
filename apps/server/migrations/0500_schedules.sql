-- Recurring tasks (M5, docs/ARCHITECTURE.md section 10). Projection of the Schedule* events; `next_fire_at` is computed
-- by the server (cron + time zone) and carried in the events, so a rebuild reproduces it.
CREATE TABLE schedules (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES users(id),
  project_id    uuid NOT NULL REFERENCES projects(id),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('feed','regression','card')),
  cron          text NOT NULL,
  timezone      text NOT NULL,
  card_template jsonb NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  next_fire_at  timestamptz,
  last_fired_at timestamptz,
  last_card_id  uuid,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
CREATE INDEX schedules_due ON schedules (next_fire_at) WHERE enabled;
CREATE INDEX schedules_project ON schedules (project_id);
