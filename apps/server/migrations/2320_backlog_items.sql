-- Project backlog: wanted work kept outside development until it is sent to the BA (BacklogItem* projection).
-- No foreign keys into projection tables (a rebuild truncates them).
CREATE TABLE IF NOT EXISTS backlog_items (
  id                    uuid PRIMARY KEY,
  org_id                uuid NOT NULL,
  project_id            uuid NOT NULL,
  title                 text NOT NULL,
  description           text NOT NULL DEFAULT '',
  priority              text NOT NULL DEFAULT 'normal' CHECK (priority IN ('critical','high','normal','low')),
  tags                  text[] NOT NULL DEFAULT '{}',
  flagged               boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  source_kind           text NOT NULL CHECK (source_kind IN ('owner','agent')),
  source_user_id        uuid,
  source_agent_id       uuid,
  source_agent_name     text,
  source_shift_id       uuid,
  source_card_id        uuid,
  source_card_ref       text,
  card_id               uuid,
  card_ref              text,
  reported_desk_item_id uuid,
  reported_at           timestamptz,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS backlog_items_project ON backlog_items (project_id, status);
CREATE INDEX IF NOT EXISTS backlog_items_unreported ON backlog_items (org_id) WHERE source_kind = 'agent' AND reported_at IS NULL;
