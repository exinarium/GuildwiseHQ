-- S-B2 agent UX. Projections of AgentMentionPolicySet, CardMentionRequested / Ended, FollowUpDaysSet, DeskItemNudged and
-- DeskItemSnoozed; all replay-safe (upserts and guarded updates).

-- Whether project members (not only Owners and Admins) may mention an agent in a card comment. No row: off.
CREATE TABLE IF NOT EXISTS agent_mention_policy (
  agent_id      uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  allow_members boolean NOT NULL DEFAULT false,
  changed_by    uuid,
  changed_at    timestamptz NOT NULL
);

-- One accepted @agent mention in a card comment: the rate limit counts these, and the run's state is kept for the thread.
CREATE TABLE IF NOT EXISTS card_mentions (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  project_id   uuid NOT NULL,
  card_id      uuid NOT NULL,
  agent_id     uuid NOT NULL,
  requested_by uuid NOT NULL,
  comment_id   uuid NOT NULL,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running','replied','failed')),
  reason       text,
  created_at   timestamptz NOT NULL,
  ended_at     timestamptz
);
CREATE INDEX IF NOT EXISTS card_mentions_user ON card_mentions (requested_by, created_at);
CREATE INDEX IF NOT EXISTS card_mentions_card ON card_mentions (card_id, created_at);

-- The organization's chase window in days (default 3 when there is no row; 0 is off).
CREATE TABLE IF NOT EXISTS org_follow_up (
  org_id     uuid PRIMARY KEY,
  days       integer NOT NULL CHECK (days BETWEEN 0 AND 30),
  changed_by uuid,
  changed_at timestamptz NOT NULL
);

-- Follow-up state of a desk item: when it was last chased, how often, and a snooze.
CREATE TABLE IF NOT EXISTS desk_follow_ups (
  desk_item_id  uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  last_nudge_at timestamptz,
  nudge_count   integer NOT NULL DEFAULT 0,
  snoozed_until timestamptz,
  updated_at    timestamptz NOT NULL
);
