-- Script-first review and scheduled publishing of videos (docs/BLOG-API.md "YouTube"). Safe to run again.
--
-- video_posts is a PROJECTION: slot, publish mode, destinations and captions come from VideoPostScheduled (appended right
-- after VideoPostApproved). The slot of a format is unique among approved posts, enforced by the schedule command under the
-- lock `video-slot:<format>` and NOT by an index: a swap moves two posts through each other's slot, which a unique index
-- would refuse while the projector replays it.
ALTER TABLE video_posts ADD COLUMN IF NOT EXISTS slot_at timestamptz;
ALTER TABLE video_posts ADD COLUMN IF NOT EXISTS publish_mode text;
ALTER TABLE video_posts DROP CONSTRAINT IF EXISTS video_posts_publish_mode_check;
ALTER TABLE video_posts ADD CONSTRAINT video_posts_publish_mode_check CHECK (publish_mode IS NULL OR publish_mode IN ('slot','now'));
ALTER TABLE video_posts ADD COLUMN IF NOT EXISTS destinations text[] NOT NULL DEFAULT '{}';
ALTER TABLE video_posts ADD COLUMN IF NOT EXISTS captions jsonb;
CREATE INDEX IF NOT EXISTS video_posts_slot ON video_posts (format, slot_at) WHERE status = 'approved' AND slot_at IS NOT NULL;

-- video_renders is operational: the render starts at not_before (the slot minus the render lead); a preview render of a
-- script that is still in review starts at once.
ALTER TABLE video_renders ADD COLUMN IF NOT EXISTS not_before timestamptz;
ALTER TABLE video_renders ADD COLUMN IF NOT EXISTS preview boolean NOT NULL DEFAULT false;
DROP INDEX IF EXISTS video_renders_queue;
CREATE INDEX IF NOT EXISTS video_renders_queue ON video_renders (not_before, created_at) WHERE status IN ('queued','rendering');

-- Instagram and TikTok are video destinations (never share networks of the blog sweep: SOCIAL_NETWORKS has four).
ALTER TABLE social_channels DROP CONSTRAINT IF EXISTS social_channels_network_check;
ALTER TABLE social_channels ADD CONSTRAINT social_channels_network_check
  CHECK (network IN ('facebook','linkedin','x','bluesky','youtube','instagram','tiktok'));
ALTER TABLE social_shares DROP CONSTRAINT IF EXISTS social_shares_network_check;
ALTER TABLE social_shares ADD CONSTRAINT social_shares_network_check
  CHECK (network IN ('facebook','linkedin','x','bluesky','youtube','instagram','tiktok'));
