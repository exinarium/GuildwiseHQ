-- Release announcements: social posts that are not blog articles (docs/BLOG-API.md "Release announcements"). Safe to run again.
--
-- social_posts is a PROJECTION of the SocialPost* events (listed in PROJECTION_TABLES). One post per (kind, ref); for a
-- release the ref is its version, so a release is announced at most once.
CREATE TABLE IF NOT EXISTS social_posts (
  id               uuid PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('release')),
  ref              text NOT NULL,
  content          jsonb NOT NULL,                       -- the SocialPostContent of the latest revision
  title            text NOT NULL,
  status           text NOT NULL CHECK (status IN ('draft','in_review','approved','rejected')),
  rejection_reason text,
  origin_user_id   uuid,
  origin_system    text,
  review_since     timestamptz,
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  UNIQUE (kind, ref)
);
CREATE INDEX IF NOT EXISTS social_posts_status ON social_posts (status, approved_at);

-- Which table a share row's post_id points at (no foreign key: shares are operational and survive a projection rebuild).
ALTER TABLE social_shares ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'blog';
DO $$ BEGIN
  ALTER TABLE social_shares ADD CONSTRAINT social_shares_source_check CHECK (source IN ('blog','social'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The blog writer's runs include the drafting of a release post.
ALTER TABLE blog_writer_runs DROP CONSTRAINT IF EXISTS blog_writer_runs_kind_check;
DO $$ BEGIN
  ALTER TABLE blog_writer_runs ADD CONSTRAINT blog_writer_runs_kind_check CHECK (kind IN ('scheduled','manual','release'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
