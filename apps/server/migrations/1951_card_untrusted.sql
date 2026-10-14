-- Cards made from an incoming webhook (#14): which card fields (and whether the title) were filled from the payload.
-- Briefs render those in an untrusted block, as they do for cards made from e-mail (`mail_threads.untrusted_*`).
-- Operational, written by the run that made the card; no foreign keys, so a projection rebuild does not touch it.
CREATE TABLE card_untrusted (
  card_id    uuid PRIMARY KEY,
  org_id     uuid NOT NULL,
  source     text NOT NULL CHECK (source IN ('webhook')),
  fields     text[] NOT NULL DEFAULT '{}',
  title      boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);
