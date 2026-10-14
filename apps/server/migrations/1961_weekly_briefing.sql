-- Weekly briefing (backlog #38). Operational tables (like the blog digest's): a person's opt-out, and one row per
-- person, organization and week that claims the send, so a week is mailed at most once however often the tick runs.
CREATE TABLE briefing_prefs (
  user_id    uuid PRIMARY KEY,
  enabled    boolean NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE briefing_deliveries (
  user_id    uuid NOT NULL,
  org_id     uuid NOT NULL,
  week       text NOT NULL,                 -- 'YYYY-Www' of the due Monday in the organization's time zone
  state      text NOT NULL CHECK (state IN ('sent', 'skipped', 'failed')),
  attempts   integer NOT NULL DEFAULT 1,
  sent_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id, org_id, week)
);
