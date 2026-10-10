-- Launch-set articles (data migration blog-launch-2026-10): pre-loaded, owner-approved posts. They are never shared to
-- social networks and never in the weekly digest, and they do not start the two-week review period of the writer agent.
-- Set from BlogPostSubmitted.launch by the projection, so a rebuild keeps it. Safe to run again.
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS launch boolean NOT NULL DEFAULT false;
