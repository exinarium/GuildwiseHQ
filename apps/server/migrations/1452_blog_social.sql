-- Facebook Page and LinkedIn organization sharing (docs/design/blog-prd.md section 12). Operational tables, no foreign
-- keys. Tokens are AES-256-GCM blobs from auth/secrets.ts and never leave the server. Safe to run again.
CREATE TABLE IF NOT EXISTS social_channels (
  network        text PRIMARY KEY CHECK (network IN ('facebook','linkedin')),
  account_id     text NOT NULL,
  account_name   text NOT NULL DEFAULT '',
  access_token   text NOT NULL,                          -- encrypted
  refresh_token  text,                                   -- encrypted
  expires_at     timestamptz,
  status         text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','needs_reconnect')),
  alerted_at     timestamptz,                            -- the one alert mail per problem
  connected_by   uuid,
  connected_at   timestamptz NOT NULL
);

-- One row per post and network: the unique key is what makes a second post to the same network impossible.
CREATE TABLE IF NOT EXISTS social_shares (
  post_id          uuid NOT NULL,
  network          text NOT NULL CHECK (network IN ('facebook','linkedin')),
  status           text NOT NULL CHECK (status IN ('pending','posting','sent','failed','skipped')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  external_id      text,
  url              text,
  error            text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  PRIMARY KEY (post_id, network)
);
CREATE INDEX IF NOT EXISTS social_shares_due ON social_shares (next_attempt_at) WHERE status = 'pending';
