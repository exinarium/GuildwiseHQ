-- Public form hosting (docs/investigations/GWP-65-public-form-hosting-public-url-qr-code-per-client.md).
-- form_publications and form_client_links are projections of the FormPublished / FormClientLink* events.
-- form_submissions is operational and holds ONLY references: status, timestamps, form version, the client link and
-- the storage references. No answer, no file content, no IP address, no user agent, no file name is stored.
CREATE TABLE IF NOT EXISTS form_publications (
  form_id         uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  public_id       text NOT NULL UNIQUE,
  version         integer NOT NULL,
  status          text NOT NULL CHECK (status IN ('published','unpublished')),
  published_at    timestamptz NOT NULL,
  published_by    uuid NOT NULL,
  unpublished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS form_publications_org ON form_publications (org_id);

CREATE TABLE IF NOT EXISTS form_client_links (
  id                   text PRIMARY KEY,
  org_id               uuid NOT NULL,
  form_id              uuid NOT NULL,
  reference            text NOT NULL,
  record_kind          text,
  record_id            text,
  expires_at           timestamptz NOT NULL,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL,
  revoked_at           timestamptz,
  revoked_by           uuid,
  used_at              timestamptz,
  used_by_submission   uuid
);
CREATE INDEX IF NOT EXISTS form_client_links_form ON form_client_links (form_id, created_at DESC);

CREATE TABLE IF NOT EXISTS form_submissions (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL,
  form_id        uuid NOT NULL,
  form_version   integer NOT NULL,
  link_id        text,
  status         text NOT NULL CHECK (status IN ('receiving','storing','failed','complete','expired')),
  error_code     text,
  session_nonce  text NOT NULL UNIQUE,
  parts          jsonb NOT NULL,
  answers_refs   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  completed_at   timestamptz,
  expires_at     timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS form_submissions_form ON form_submissions (form_id, created_at DESC);
