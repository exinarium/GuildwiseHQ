-- Feeds (M5): the items curators log (the project's running list, ordered oldest to newest), their verdicts, and the
-- seen-list by normalized URL.
CREATE TABLE digest_items (
  id             uuid PRIMARY KEY,
  card_id        uuid NOT NULL REFERENCES cards(id),
  project_id     uuid NOT NULL REFERENCES projects(id),
  desk_item_id   uuid,                                   -- the grouped rating item of the digest (no FK: created in the same append)
  kind           text NOT NULL,
  url            text NOT NULL,
  url_normalized text NOT NULL,
  title          text NOT NULL,
  source         text NOT NULL,
  published_at   timestamptz,
  summary        text NOT NULL,
  position       integer NOT NULL,                       -- order inside its digest
  verdict        text CHECK (verdict IN ('useful','irrelevant','boring')),
  verdict_reason text,
  rated_by       uuid REFERENCES users(id),
  rated_at       timestamptz,
  event_seq      bigint NOT NULL,
  created_at     timestamptz NOT NULL
);
CREATE INDEX digest_items_project ON digest_items (project_id, event_seq, position);
CREATE INDEX digest_items_desk ON digest_items (desk_item_id) WHERE desk_item_id IS NOT NULL;

CREATE TABLE feed_seen (
  project_id     uuid NOT NULL REFERENCES projects(id),
  url_normalized text NOT NULL,
  first_seen_at  timestamptz NOT NULL,
  PRIMARY KEY (project_id, url_normalized)
);
