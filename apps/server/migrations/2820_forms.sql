-- Forms builder (docs/investigations/GWP-64-forms-builder-drag-and-drop-form-designer-with-com.md).
-- forms and form_versions are projections of FormVersionSaved / FormArchived / FormUnarchived (rebuilt from events).
-- org_brand_images holds the operational bytes of a form logo (never in the event log, no foreign key, kept over a
-- projection rebuild). No form answers are stored anywhere in this schema.
CREATE TABLE IF NOT EXISTS forms (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  title           text NOT NULL,
  latest_version  integer NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  field_count     integer NOT NULL,
  created_by      uuid,
  created_at      timestamptz NOT NULL,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS forms_org ON forms (org_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS form_versions (
  form_id          uuid NOT NULL,
  version          integer NOT NULL,
  org_id           uuid NOT NULL,
  definition       jsonb NOT NULL,
  definition_hash  text NOT NULL,
  saved_by         uuid,
  saved_at         timestamptz NOT NULL,
  event_seq        bigint NOT NULL,
  PRIMARY KEY (form_id, version)
);

CREATE TABLE IF NOT EXISTS org_brand_images (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  purpose       text NOT NULL DEFAULT 'form_logo',
  content_type  text NOT NULL,
  size          integer NOT NULL,
  sha256        text NOT NULL,
  data          bytea NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS org_brand_images_org ON org_brand_images (org_id);
