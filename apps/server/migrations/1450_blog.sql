-- The platform blog (docs/design/blog-prd.md). Safe to run again.
--
-- blog_posts is a PROJECTION of the Blog* events (listed in PROJECTION_TABLES). The keys and their request log are
-- operational data like pairing_codes: only the sha256 of a key is stored, a rebuild never touches them.
CREATE TABLE IF NOT EXISTS blog_posts (
  id               uuid PRIMARY KEY,
  slug             text NOT NULL UNIQUE,
  content          jsonb NOT NULL,                       -- the BlogContent of the latest revision
  title            text NOT NULL,
  summary          text NOT NULL,
  tags             text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL CHECK (status IN ('draft','in_review','published','rejected','unpublished')),
  rejection_reason text,
  content_hash     text NOT NULL,
  origin_key_id    uuid,
  origin_user_id   uuid,
  warnings         jsonb NOT NULL DEFAULT '[]',
  word_count       integer NOT NULL DEFAULT 0,
  reading_minutes  integer NOT NULL DEFAULT 1,
  review_since     timestamptz,                          -- when it entered (or re-entered) the review queue
  published_at     timestamptz,                          -- first publish; kept on republish
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS blog_posts_status ON blog_posts (status, published_at DESC);
CREATE INDEX IF NOT EXISTS blog_posts_tags ON blog_posts USING gin (tags);

-- Agent API keys (super admin managed). No foreign keys: not a projection.
CREATE TABLE IF NOT EXISTS blog_api_keys (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  prefix        text NOT NULL,                           -- first characters, to recognise a key in the list
  key_hash      text NOT NULL UNIQUE,                    -- sha256 hex of the full key
  scopes        text[] NOT NULL,
  ip_allow_list text[] NOT NULL DEFAULT '{}',
  created_by    uuid,
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  last_ip       text
);

-- One row per API request: the audit trail, and the counters of the rate limits and the daily post cap.
CREATE TABLE IF NOT EXISTS blog_api_log (
  id       bigserial PRIMARY KEY,
  key_id   uuid NOT NULL,
  at       timestamptz NOT NULL,
  method   text NOT NULL,
  path     text NOT NULL,
  status   integer NOT NULL,
  ip       text,
  is_write boolean NOT NULL DEFAULT false,
  is_post  boolean NOT NULL DEFAULT false               -- a newly accepted post (counts to the 24 h cap)
);
CREATE INDEX IF NOT EXISTS blog_api_log_key_at ON blog_api_log (key_id, at DESC);
CREATE INDEX IF NOT EXISTS blog_api_log_at ON blog_api_log (at DESC);
