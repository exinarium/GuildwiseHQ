-- The landing-page assistant keeps counters only, never conversations: messages per hashed visitor address and hour or
-- day, messages per day, and the day's spend in micro-US-dollars. Old buckets are deleted as new ones are written.
CREATE TABLE assistant_counters (
  key        text NOT NULL,                 -- 'ip:<hash>' | 'all' | 'spend'
  bucket     text NOT NULL,                 -- 'h:2026-10-10T13' | 'd:2026-10-10'
  n          bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (key, bucket)
);
CREATE INDEX assistant_counters_updated ON assistant_counters (updated_at);
