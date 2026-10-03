-- Research (M6): the notes checkers publish. The note itself lives in the project's vault folder; the site records
-- where it is, what it is called and the citations it carries.
CREATE TABLE research_publications (
  id          uuid PRIMARY KEY,
  card_id     uuid NOT NULL REFERENCES cards(id),
  project_id  uuid NOT NULL REFERENCES projects(id),
  vault_path  text NOT NULL,
  title       text NOT NULL,
  citations   jsonb NOT NULL,
  excerpt     text NOT NULL DEFAULT '',
  event_seq   bigint NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX research_publications_project ON research_publications (project_id, event_seq DESC);
CREATE INDEX research_publications_card ON research_publications (card_id);
