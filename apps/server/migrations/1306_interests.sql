-- Interests (docs/design/interests.md): one statement per topic the manager cares about, owning the feed schedule
-- that scans for it, plus explicit taste rules per feed project. Projections of Interest*, ScheduleLinked and
-- TasteSeedSet events. (The design reserved 1500_; 1306 is the next free number after the hygiene migration.)
CREATE TABLE interests (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES users(id),
  name                text NOT NULL,
  description         text NOT NULL DEFAULT '',
  feed_project_id     uuid REFERENCES projects(id),
  research_project_id uuid REFERENCES projects(id),
  sub_category        text,
  preferred_sites     text[] NOT NULL DEFAULT '{}',
  scan                jsonb,            -- {cron, timezone, windowHours, maxItems, manual}; NULL when there is no feed project
  status              text NOT NULL CHECK (status IN ('active','paused')),
  schedule_id         uuid,             -- the feed schedule it owns (no FK: created in the same append)
  adopted_from        uuid,             -- the schedule it was adopted from, if any
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  CHECK (feed_project_id IS NOT NULL OR research_project_id IS NOT NULL)
);
CREATE UNIQUE INDEX interests_name ON interests (org_id, lower(name));
CREATE INDEX interests_feed_project ON interests (feed_project_id) WHERE feed_project_id IS NOT NULL;
CREATE INDEX interests_research_project ON interests (research_project_id) WHERE research_project_id IS NOT NULL;

ALTER TABLE schedules ADD COLUMN interest_id uuid;
CREATE UNIQUE INDEX schedules_interest ON schedules (interest_id) WHERE interest_id IS NOT NULL;

ALTER TABLE cards ADD COLUMN interest_id uuid;
CREATE INDEX cards_interest ON cards (interest_id) WHERE interest_id IS NOT NULL;

CREATE TABLE taste_seeds (
  project_id  uuid PRIMARY KEY REFERENCES projects(id),
  version     integer NOT NULL,           -- bumps on every TasteSeedSet; carried to the vault section to drop stale writes
  rules       jsonb NOT NULL DEFAULT '[]', -- [{text, interestId | null}]
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL
);
