-- The blog writer's topic queue (docs/design/ceo-blog-topics.md, Phase 1). A projection of the BlogTopic* events on the
-- `blog-topics` stream. There is NO org id, candidate id or foreign key here, by design (section 3.2): the writer and
-- this table never learn which organization (if any) a question came from.
CREATE TABLE IF NOT EXISTS blog_topics (
  id          uuid PRIMARY KEY,               -- topicId
  question    text NOT NULL,
  area        text NOT NULL,
  origin      text NOT NULL CHECK (origin IN ('platform','customer')),
  status      text NOT NULL CHECK (status IN ('queued','writing','drafted','published','declined','rejected','duplicate')),
  reason      text,
  attempts    integer NOT NULL DEFAULT 0,     -- writer runs that took the topic (a technical failure retries once)
  post_id     uuid,                           -- the article written for it (no foreign key)
  run_id      uuid,                           -- the writer run that took it last (no foreign key)
  queued_at   timestamptz NOT NULL,
  sort_at     timestamptz NOT NULL,           -- queue order: queued_at, or earlier when a super admin moved it up
  updated_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS blog_topics_queue ON blog_topics (sort_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS blog_topics_post ON blog_topics (post_id) WHERE post_id IS NOT NULL;

-- Operational, like the table it is on: which queued topic a run wrote (null for the rotation).
ALTER TABLE blog_writer_runs ADD COLUMN IF NOT EXISTS topic_id uuid;

-- The organization-level consent "Share diagnostic data with Guildwise" (OrgDiagnosticsSharingSet), off by default.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS diagnostics_sharing         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS diagnostics_consent_version text,
  ADD COLUMN IF NOT EXISTS diagnostics_sharing_at      timestamptz;
