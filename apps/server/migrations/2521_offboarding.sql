-- S-B1 offboarding: a removed member's private items are deleted after a grace period (projection of MemberOffboarded /
-- OffboardingPurgeRan). `status`: pending until the purge ran, or it was cancelled because the person came back.
CREATE TABLE IF NOT EXISTS offboarding_purges (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL,
  user_id     uuid NOT NULL,
  purge_after timestamptz NOT NULL,
  chat_ids    uuid[] NOT NULL DEFAULT '{}',
  pack_ids    uuid[] NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
  created_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS offboarding_purges_due ON offboarding_purges (purge_after) WHERE status = 'pending';
