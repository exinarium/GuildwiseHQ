-- Ship release (release prep 4/4): tag and forge release after the release PR is merged.
ALTER TABLE project_repos ADD COLUMN IF NOT EXISTS release_name text;   -- null: the project name
UPDATE project_repos SET release_name = 'Guildwise HQ'
 WHERE remote_url_normalized = 'github.com/exinarium/guildwisehq' AND release_name IS NULL;

ALTER TABLE release_ships DROP CONSTRAINT IF EXISTS release_ships_status_check;
ALTER TABLE release_ships ADD CONSTRAINT release_ships_status_check
  CHECK (status IN ('committing','committed','tagged','published','failed'));

ALTER TABLE release_ships
  ADD COLUMN IF NOT EXISTS land_mode text CHECK (land_mode IN ('pr','merge')),
  ADD COLUMN IF NOT EXISTS pr_url text,
  ADD COLUMN IF NOT EXISTS merge_sha text,
  ADD COLUMN IF NOT EXISTS landed_at timestamptz,
  ADD COLUMN IF NOT EXISTS tag_name text,
  ADD COLUMN IF NOT EXISTS tag_sha text,
  ADD COLUMN IF NOT EXISTS tag_url text,
  ADD COLUMN IF NOT EXISTS tag_state text,
  ADD COLUMN IF NOT EXISTS tagged_at timestamptz,
  ADD COLUMN IF NOT EXISTS release_url text,
  ADD COLUMN IF NOT EXISTS release_state text CHECK (release_state IN ('created','existed','none')),
  ADD COLUMN IF NOT EXISTS release_latest boolean,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_desk_item_id uuid,
  ADD COLUMN IF NOT EXISTS step_message text,
  ADD COLUMN IF NOT EXISTS publish_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS publish_checks int NOT NULL DEFAULT 0;
