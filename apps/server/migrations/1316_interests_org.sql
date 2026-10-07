-- Org-level interests (docs/design/restructure.md Part D). Each interest is backed by a hidden project
-- (`projects.kind = 'interest'`) that carries its feed and research cards, digest items, seen-list, transcripts and
-- vault folder. The interest owns its run schedule, its delivery schedule and its taste rules; the run log is the
-- projection `interest_runs`. Projection of the Interest*, ProjectKindChanged and DigestPosted events.
-- Safe to run again: every step checks what is already there.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'project';
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_kind_check;
ALTER TABLE projects ADD CONSTRAINT projects_kind_check CHECK (kind IN ('project','interest'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS vault_dir text;   -- full vault-relative folder (interests/<slug>); NULL = projects/<vault_folder or key>
CREATE INDEX IF NOT EXISTS projects_visible ON projects (org_id) WHERE kind = 'project';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'interests' AND column_name = 'feed_project_id') THEN
    ALTER TABLE interests RENAME COLUMN feed_project_id TO legacy_feed_project_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'interests' AND column_name = 'research_project_id') THEN
    ALTER TABLE interests RENAME COLUMN research_project_id TO legacy_research_project_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'interests' AND column_name = 'schedule_id') THEN
    ALTER TABLE interests RENAME COLUMN schedule_id TO legacy_schedule_id;
  END IF;
END $$;
ALTER TABLE interests DROP CONSTRAINT IF EXISTS interests_check;   -- "feed or research project" no longer applies

ALTER TABLE interests ADD COLUMN IF NOT EXISTS project_id        uuid REFERENCES projects(id);   -- the backing project; set once migrated
ALTER TABLE interests ADD COLUMN IF NOT EXISTS slug              text;                            -- vault folder name, immutable
ALTER TABLE interests ADD COLUMN IF NOT EXISTS domain            text CHECK (domain IN ('work','personal'));
ALTER TABLE interests ADD COLUMN IF NOT EXISTS kinds             text[] NOT NULL DEFAULT '{article,video,podcast}';
ALTER TABLE interests ADD COLUMN IF NOT EXISTS agents            jsonb NOT NULL DEFAULT '{}';     -- {scout?, curator?, researcher?, checker?}: a soft preference
ALTER TABLE interests ADD COLUMN IF NOT EXISTS delivery          jsonb NOT NULL DEFAULT '{"mode":"immediate","cron":"0 7 * * 1-5","timezone":"UTC"}';
ALTER TABLE interests ADD COLUMN IF NOT EXISTS taste_rules       jsonb NOT NULL DEFAULT '[]';     -- string[]
ALTER TABLE interests ADD COLUMN IF NOT EXISTS taste_version     integer NOT NULL DEFAULT 0;
ALTER TABLE interests ADD COLUMN IF NOT EXISTS next_scan_at      timestamptz;
ALTER TABLE interests ADD COLUMN IF NOT EXISTS next_delivery_at  timestamptz;
ALTER TABLE interests ADD COLUMN IF NOT EXISTS last_delivered_at timestamptz;
ALTER TABLE interests ADD COLUMN IF NOT EXISTS fail_count        integer NOT NULL DEFAULT 0;
ALTER TABLE interests ADD COLUMN IF NOT EXISTS last_error        text;
ALTER TABLE interests ADD COLUMN IF NOT EXISTS failure_desk_item_id uuid;
ALTER TABLE interests ADD COLUMN IF NOT EXISTS archived_at       timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS interests_slug ON interests (org_id, slug) WHERE slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS interests_project ON interests (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS interests_due ON interests (next_scan_at) WHERE status = 'active' AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS interests_delivery_due ON interests (next_delivery_at) WHERE status = 'active' AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS interest_runs (
  id            uuid PRIMARY KEY,
  interest_id   uuid NOT NULL,
  org_id        uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('scan','research')),
  trigger       text NOT NULL CHECK (trigger IN ('cron','manual','after_scan','migrated')),
  card_id       uuid NOT NULL,
  parent_run_id uuid,
  status        text NOT NULL CHECK (status IN ('queued','scanning','curating','researching','checking',
                                                 'published','nothing','failed','cancelled')),
  found         integer,                    -- scout candidates (NULL for migrated runs: not recorded)
  published     integer,                    -- digest items or notes
  duplicates_dropped integer,
  over_max_dropped   integer,
  started_by    uuid REFERENCES users(id),
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS interest_runs_interest ON interest_runs (interest_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS interest_runs_card ON interest_runs (card_id);

-- Batches delivered to the desk (a row per delivery time that had something to say).
CREATE TABLE IF NOT EXISTS interest_deliveries (
  id            uuid PRIMARY KEY,
  interest_id   uuid NOT NULL,
  org_id        uuid NOT NULL,
  at            timestamptz NOT NULL,
  item_count    integer NOT NULL,
  held_back     integer NOT NULL DEFAULT 0,
  trigger       text NOT NULL DEFAULT 'schedule',
  desk_item_id  uuid
);
CREATE INDEX IF NOT EXISTS interest_deliveries_interest ON interest_deliveries (interest_id, at DESC);
CREATE INDEX IF NOT EXISTS interest_deliveries_org ON interest_deliveries (org_id, at DESC);

ALTER TABLE cards ADD COLUMN IF NOT EXISTS interest_run_id   uuid;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS preferred_agents  jsonb;   -- {roleKey: agentId}, a soft preference
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_origin_check;
ALTER TABLE cards ADD CONSTRAINT cards_origin_check
  CHECK (origin IN ('manual','intake','schedule','test_failure','full_suite','regression','interest'));

-- Items wait here until a delivery puts them on the desk. Items that exist already were delivered when they were posted.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'digest_items' AND column_name = 'delivered_at') THEN
    ALTER TABLE digest_items ADD COLUMN delivered_at timestamptz;
    UPDATE digest_items SET delivered_at = created_at;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS digest_items_held ON digest_items (card_id) WHERE delivered_at IS NULL;
