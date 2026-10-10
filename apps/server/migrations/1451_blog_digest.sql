-- Weekly blog digest (docs/design/blog-prd.md section 11). Operational tables, no foreign keys: a projection rebuild or
-- a restart never sends a digest again. Safe to run again.

-- A person's choice. A row exists only once someone has chosen (or been chosen for by the sign-up checkbox); an org Owner
-- without a row counts as opted in, everyone else as opted out. The unsubscribe token is a random 32 bytes kept as a
-- sha256; the plain token is derived by signing (see commands/blog-digest.ts), so a link never needs storing.
CREATE TABLE IF NOT EXISTS blog_digest_prefs (
  user_id     uuid PRIMARY KEY,
  opted_in    boolean NOT NULL,
  via         text NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS blog_digests (
  digest_id   text PRIMARY KEY,                          -- blog-digest-<ISO week>
  cutoff      timestamptz NOT NULL,                      -- the digest covers posts published up to here
  post_ids    uuid[] NOT NULL DEFAULT '{}',
  state       text NOT NULL CHECK (state IN ('sending','sent','skipped')),
  recipients  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL,
  finished_at timestamptz,
  note        text
);

CREATE TABLE IF NOT EXISTS blog_digest_deliveries (
  digest_id   text NOT NULL REFERENCES blog_digests(digest_id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  email       text NOT NULL,
  state       text NOT NULL CHECK (state IN ('pending','sent','failed')),
  attempts    integer NOT NULL DEFAULT 0,
  sent_at     timestamptz,
  PRIMARY KEY (digest_id, user_id)
);
