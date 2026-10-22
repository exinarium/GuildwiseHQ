-- Documents (brief, PRD, minutes, session log) held on the server while drafted and published to the vault once approved
-- (docs/design/discovery-boardroom-registry.md). Projection tables rebuilt from the `Document*` events.
CREATE TABLE IF NOT EXISTS documents (
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL,
  project_id        uuid,
  kind              text NOT NULL CHECK (kind IN ('brief','prd','minutes','session_log')),
  title             text NOT NULL,
  slug              text NOT NULL,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','handed_off','archived')),
  current_version   int NOT NULL DEFAULT 0,
  approved_version  int,
  source_thread_ids uuid[] NOT NULL DEFAULT '{}',
  publish_state     text NOT NULL DEFAULT 'none' CHECK (publish_state IN ('none','pending','queued')),
  publish_version   int,                        -- the version the vault copy is owed or was queued for
  published_version int,
  vault_id          uuid,
  vault_path        text,
  created_by        uuid,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_org ON documents (org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS documents_project ON documents (project_id, updated_at DESC) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS documents_slug ON documents (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
CREATE INDEX IF NOT EXISTS documents_publish_pending ON documents (org_id) WHERE publish_state = 'pending';

CREATE TABLE IF NOT EXISTS document_versions (
  id            uuid PRIMARY KEY,
  document_id   uuid NOT NULL,
  version       int NOT NULL,
  content       text NOT NULL,
  note          text,
  saved_by_kind text NOT NULL,
  saved_by_id   text,
  event_seq     bigint NOT NULL,
  created_at    timestamptz NOT NULL,
  UNIQUE (document_id, version)
);
