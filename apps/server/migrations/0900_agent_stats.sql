-- HR board track record (M9). Every table here is a projection of events (agent shifts, handoffs, reviews, test
-- failures, questions) so `projections:rebuild` reproduces it; there is no refresh job. Stats over a rolling window are
-- computed from these rows at read time.

-- One row per agent and card the agent touched: the unit of the blocked, rework and bug rates.
CREATE TABLE agent_card_stats (
  agent_id            uuid NOT NULL,                 -- no FK: rows are derived; agents may be deleted by test helpers
  card_id             uuid NOT NULL REFERENCES cards(id),
  org_id              uuid NOT NULL,
  project_id          uuid NOT NULL,
  role_key            text NOT NULL,
  risk_tier           text,                          -- 'small' | 'large' (null until the builder submitted the diff)
  first_at            timestamptz NOT NULL,
  last_at             timestamptz NOT NULL,
  done_at             timestamptz,                   -- last terminal report (handoff)
  submitted           boolean NOT NULL DEFAULT false, -- builder: sent the card to review
  questions           integer NOT NULL DEFAULT 0,
  rework_rounds       integer NOT NULL DEFAULT 0,    -- bounces that count against the builder
  spec_unclear_rounds integer NOT NULL DEFAULT 0,    -- bounces blamed on the spec (not on the builder)
  bugs                integer NOT NULL DEFAULT 0,    -- test failures and later suite failures traced to this builder
  criteria_missed     integer NOT NULL DEFAULT 0,
  tokens              bigint NOT NULL DEFAULT 0,     -- input + output tokens of its shifts on the card
  shift_ms            bigint NOT NULL DEFAULT 0,
  diff_files          integer,
  test_files          integer,                       -- null: the runner did not report test files
  PRIMARY KEY (agent_id, card_id)
);
CREATE INDEX agent_card_stats_window ON agent_card_stats (org_id, last_at);

-- One row per review verdict, attributed to the builder of the card (and, for an unclear spec, to its author).
CREATE TABLE agent_review_log (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                uuid NOT NULL,
  project_id            uuid NOT NULL,
  card_id               uuid NOT NULL REFERENCES cards(id),
  builder_agent_id      uuid,
  reviewer_agent_id     uuid,
  spec_author_agent_id  uuid,
  verdict               text NOT NULL CHECK (verdict IN ('approved','changes')),
  score                 smallint,
  reasons               text[] NOT NULL DEFAULT '{}',
  criteria_missed       integer NOT NULL DEFAULT 0,
  risk_tier             text,
  at                    timestamptz NOT NULL
);
CREATE INDEX agent_review_log_builder ON agent_review_log (builder_agent_id, at);
CREATE INDEX agent_review_log_reviewer ON agent_review_log (reviewer_agent_id, at);

-- Shift time, tokens and finished cards per agent and UTC day (utilisation, sparklines).
CREATE TABLE agent_stats_daily (
  agent_id    uuid NOT NULL,
  day         date NOT NULL,
  shifts      integer NOT NULL DEFAULT 0,
  shift_ms    bigint NOT NULL DEFAULT 0,
  tokens      bigint NOT NULL DEFAULT 0,
  cards_done  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day)
);

-- Recommendations that were applied: they stay out of the list while the evidence window still contains the cause.
CREATE TABLE hr_applied (
  org_id             uuid NOT NULL,
  recommendation_id  text NOT NULL,
  applied_at         timestamptz NOT NULL,
  applied_by         uuid,
  PRIMARY KEY (org_id, recommendation_id)
);

-- Scheduler health: a schedule that cannot fire backs off instead of retrying every tick.
ALTER TABLE schedules
  ADD COLUMN fail_count            integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error            text,
  ADD COLUMN failure_desk_item_id  uuid;
