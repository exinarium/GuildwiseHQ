-- The server-side blog writer (platform job, uses the platform Anthropic key).
-- blog_writer_runs is OPERATIONAL (money spent, slots claimed): it has no foreign key to a projection, so a projection
-- rebuild never touches it. One row per run; `slot` is unique, so a slot (or a manual run) is claimed before the API is called.
CREATE TABLE IF NOT EXISTS blog_writer_runs (
  id            uuid PRIMARY KEY,
  slot          text NOT NULL UNIQUE,
  kind          text NOT NULL CHECK (kind IN ('scheduled', 'manual')),
  status        text NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'skipped')),
  topic         text,
  model         text,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  searches      integer NOT NULL DEFAULT 0,
  -- millionths of a US dollar
  cost_micros   bigint NOT NULL DEFAULT 0,
  post_id       uuid,
  slug          text,
  error         text
);
CREATE INDEX IF NOT EXISTS blog_writer_runs_started ON blog_writer_runs (started_at DESC);

-- Who wrote a post when it was neither an API key nor a person (the platform job): set from BlogPostSubmitted, so a rebuild keeps it.
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS origin_system text;
