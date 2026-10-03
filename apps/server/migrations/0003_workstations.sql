CREATE TABLE workstations (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  name           text NOT NULL,
  platform       text,                                -- linux | darwin | win32
  hostname       text,
  runner_version text,
  token_hash     text NOT NULL UNIQUE,                -- sha256 hex of runner token
  status         text NOT NULL CHECK (status IN ('active','unlinked')),
  runtimes       jsonb NOT NULL DEFAULT '[]',         -- [{id, version, available, capabilities[]}] from hello
  paired_at      timestamptz NOT NULL,
  unlinked_at    timestamptz,
  connected      boolean NOT NULL DEFAULT false,      -- operational
  last_seen_at   timestamptz                          -- operational
);
CREATE INDEX workstations_user ON workstations (user_id);

CREATE TABLE pairing_codes (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES users(id),
  code_hash   text NOT NULL UNIQUE,                   -- sha256 hex of normalized code
  expires_at  timestamptz NOT NULL,                   -- created_at + 10 min
  used_at     timestamptz,
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL
);
