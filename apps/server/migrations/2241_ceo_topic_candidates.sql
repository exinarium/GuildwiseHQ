-- Research-topic candidates of an organization (docs/design/ceo-blog-topics.md, Phase 2). A projection of the CeoTopic*
-- events on the `ceo-<orgId>` stream. Org-scoped; never read by `blog/**` (blog-writer-boundary.test.ts). `topic_id` is the
-- only key to the platform side (`blog_topics`), which has no key back. No foreign keys into other projection tables
-- (a rebuild TRUNCATEs them).
CREATE TABLE IF NOT EXISTS ceo_topic_candidates (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  status        text NOT NULL CHECK (status IN ('note','proposed','accepted','rejected','merged','expired','queued',
                                                'duplicate','declined','published','withdrawn','blocked')),
  source_kind   text NOT NULL,                       -- offboard_job | repeat | correction | loop | deploy | desk | owner
  evidence      jsonb NOT NULL DEFAULT '[]',         -- [{kind, id}]: ids only, never text
  note          text,                                -- the signal's own title (org data; stays here)
  question      text,
  area          text,
  audience      text,
  findings      jsonb NOT NULL DEFAULT '[]',
  occurrences   integer NOT NULL DEFAULT 1,
  merged_into   uuid,
  topic_id      uuid UNIQUE,                         -- set on accept
  allow_terms   text[] NOT NULL DEFAULT '{}',        -- proper nouns the reviewer confirmed for this topic
  post_slug     text,
  post_title    text,
  published_at  timestamptz,
  handed_off_at timestamptz,
  decided_by    uuid,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ceo_topic_candidates_org ON ceo_topic_candidates (org_id, status);
CREATE INDEX IF NOT EXISTS ceo_topic_candidates_handoff ON ceo_topic_candidates (status) WHERE status IN ('accepted','queued');
