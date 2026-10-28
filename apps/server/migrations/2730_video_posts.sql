-- The YouTube push (docs/BLOG-API.md "YouTube"). Safe to run again.
--
-- video_posts and video_topics are PROJECTIONS of the VideoPost* / VideoTopic* events (listed in PROJECTION_TABLES).
-- video_renders is OPERATIONAL (no foreign key, survives a projection rebuild): the worker's queue and its results.
-- The upload itself is a social_shares row (network 'youtube', source 'video') so a second upload of a post is impossible.
CREATE TABLE IF NOT EXISTS video_posts (
  id                 uuid PRIMARY KEY,
  kind               text NOT NULL CHECK (kind IN ('article','release','tutorial')),
  format             text NOT NULL CHECK (format IN ('long','short')),
  ref                text NOT NULL,                      -- article slug | release version | topic id | lib:<help video slug>
  parent_id          uuid,                               -- a Short points at its long video
  script             jsonb,                              -- VideoScript; null for a library video
  meta               jsonb NOT NULL,                     -- title, description, tags, hashtags, privacy?
  title              text NOT NULL,
  revision           integer NOT NULL DEFAULT 1,
  status             text NOT NULL CHECK (status IN ('draft','in_review','approved','rejected')),
  approved_render_id uuid,
  rejection_reason   text,
  origin_user_id     uuid,
  origin_system      text,
  review_since       timestamptz,
  approved_at        timestamptz,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  UNIQUE (kind, ref, format)
);
CREATE INDEX IF NOT EXISTS video_posts_status ON video_posts (status, approved_at);
CREATE INDEX IF NOT EXISTS video_posts_parent ON video_posts (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS video_renders (
  id           uuid PRIMARY KEY,
  post_id      uuid NOT NULL,                            -- no foreign key: survives a rebuild of video_posts
  revision     integer NOT NULL,
  status       text NOT NULL CHECK (status IN ('queued','rendering','rendered','failed')),
  lease_until  timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  error        text,
  duration_s   double precision,
  bytes        bigint,
  -- file name -> path relative to AOM_VIDEO_DIR (absolute for a library video: the help video's own file)
  artifacts    jsonb NOT NULL DEFAULT '{}'::jsonb,
  library      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  purged_at    timestamptz,
  UNIQUE (post_id, revision)
);
CREATE INDEX IF NOT EXISTS video_renders_queue ON video_renders (created_at) WHERE status IN ('queued','rendering');

-- Video topics: new "showcase" videos of what you can do with Guildwise HQ (like blog_topics, platform side only).
CREATE TABLE IF NOT EXISTS video_topics (
  id          uuid PRIMARY KEY,
  title       text NOT NULL,
  brief       text NOT NULL DEFAULT '',
  origin      text NOT NULL CHECK (origin IN ('platform','writer')),
  status      text NOT NULL CHECK (status IN ('queued','writing','drafted','rejected')),
  reason      text,
  attempts    integer NOT NULL DEFAULT 0,
  post_id     uuid,
  queued_at   timestamptz NOT NULL,
  sort_at     timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS video_topics_queue ON video_topics (sort_at) WHERE status = 'queued';

-- YouTube is a channel and an upload target, never a share network of the blog sweep (SOCIAL_NETWORKS has four).
ALTER TABLE social_channels DROP CONSTRAINT IF EXISTS social_channels_network_check;
ALTER TABLE social_channels ADD CONSTRAINT social_channels_network_check
  CHECK (network IN ('facebook','linkedin','x','bluesky','youtube'));
ALTER TABLE social_shares DROP CONSTRAINT IF EXISTS social_shares_network_check;
ALTER TABLE social_shares ADD CONSTRAINT social_shares_network_check
  CHECK (network IN ('facebook','linkedin','x','bluesky','youtube'));
ALTER TABLE social_shares DROP CONSTRAINT IF EXISTS social_shares_source_check;
ALTER TABLE social_shares ADD CONSTRAINT social_shares_source_check CHECK (source IN ('blog','social','video'));
ALTER TABLE social_shares DROP CONSTRAINT IF EXISTS social_shares_status_check;
ALTER TABLE social_shares ADD CONSTRAINT social_shares_status_check
  CHECK (status IN ('pending','posting','sent','failed','skipped','locked_private'));
-- What the upload did step by step: video id, upload session, slot, privacy, skipped steps.
ALTER TABLE social_shares ADD COLUMN IF NOT EXISTS detail jsonb;

-- The cross-post of a tutorial video is a social post of kind 'video' (ref = the video post id).
ALTER TABLE social_posts DROP CONSTRAINT IF EXISTS social_posts_kind_check;
ALTER TABLE social_posts ADD CONSTRAINT social_posts_kind_check CHECK (kind IN ('release','video'));
