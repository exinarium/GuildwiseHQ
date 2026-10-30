-- Tags and uploaded files on documents. Projection columns of `documents` (rebuilt from the `Document*` events);
-- existing rows get no tags and no file.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_name text;           -- null: an authored (text) document
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_content_type text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_size bigint;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_sha256 text;
CREATE INDEX IF NOT EXISTS documents_tags ON documents USING gin (tags);
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('brief','prd','minutes','session_log','file'));

-- The bytes of an uploaded file: operational (never in the event log, kept over a projection rebuild), like
-- card_attachment_data. No foreign key to documents: a projection TRUNCATE ... CASCADE must not empty it.
CREATE TABLE IF NOT EXISTS document_file_data (
  document_id uuid PRIMARY KEY,
  data        bytea NOT NULL
);
