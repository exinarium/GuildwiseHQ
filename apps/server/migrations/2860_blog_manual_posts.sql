-- Hand-written articles (origin_kind 'manual') next to the blog writer's posts. Set from BlogPostSubmitted.manual by the
-- projection, so a rebuild keeps it; every existing row becomes 'writer' through the default.
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS origin_kind text NOT NULL DEFAULT 'writer';
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS author_name text;
DO $$ BEGIN
  ALTER TABLE blog_posts ADD CONSTRAINT blog_posts_origin_kind CHECK (origin_kind IN ('writer','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Images of hand-written articles. OPERATIONAL (like card_attachment_data): never in the event log, kept over a
-- projection rebuild, no foreign key to the projection table.
CREATE TABLE IF NOT EXISTS blog_images (
  id           uuid PRIMARY KEY,
  post_id      uuid NOT NULL,
  content_type text NOT NULL,
  ext          text NOT NULL,
  size         integer NOT NULL,
  sha256       text NOT NULL,
  data         bytea NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS blog_images_post ON blog_images (post_id, created_at);
