-- Cost tracking and per-project budgets (docs/design/restructure.md "Roadmap after the restructure").
-- Projections of ShiftEnded / OrgCostSettingsChanged / ProjectBudget*: a rebuild reproduces every column and row.
-- Safe to run again: columns and the table are added once, and the backfill only inserts shifts without a cost row.

-- Chat shifts that belong to a project but to no card (ShiftStarted.projectId); every other shift resolves its project
-- through its card or its BA task.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS project_id uuid;

-- The organization's currency for budgets and everything shown: costs are recorded in USD (list prices) and shown as
-- usd_micros * usd_rate (units of `currency` per 1 USD).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS usd_rate numeric(18,6) NOT NULL DEFAULT 1;

-- Monthly budget in micro-units of the organization's currency; NULL: no budget. The month keys ('YYYY-MM' in the
-- organization's time zone) say which month a threshold fired or an override applies to, so the 1st resets itself.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_micros          bigint CHECK (budget_micros IS NULL OR budget_micros > 0);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_override_month  text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_warned_month    text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_paused_month    text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_desk_item_id    uuid;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_set_by          uuid;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_set_at          timestamptz;

-- One row per ended shift (chats included): what it used and what it cost at list prices.
CREATE TABLE IF NOT EXISTS shift_costs (
  shift_id           uuid PRIMARY KEY,
  org_id             uuid NOT NULL,
  agent_id           uuid NOT NULL,
  project_id         uuid,           -- NULL: org overhead (a chat or BA task without a project)
  card_id            uuid,
  phase_id           uuid,           -- BA tasks only; card shifts resolve their phase through the card
  kind               text NOT NULL,
  model              text NOT NULL,
  tokens_input       bigint NOT NULL DEFAULT 0,
  tokens_output      bigint NOT NULL DEFAULT 0,
  tokens_cache_read  bigint NOT NULL DEFAULT 0,
  tokens_cache_write bigint NOT NULL DEFAULT 0,
  cost_usd_micros    bigint NOT NULL DEFAULT 0,
  reported_usd_micros bigint,        -- what the runtime itself reported (informational)
  ended_at           timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS shift_costs_org_time     ON shift_costs (org_id, ended_at);
CREATE INDEX IF NOT EXISTS shift_costs_project_time ON shift_costs (project_id, ended_at);
CREATE INDEX IF NOT EXISTS shift_costs_agent_time   ON shift_costs (agent_id, ended_at);
CREATE INDEX IF NOT EXISTS shift_costs_card         ON shift_costs (card_id) WHERE card_id IS NOT NULL;

-- History: shifts that ended before this migration were priced by the same default table the projector uses
-- (packages/shared/src/costs: Opus 5/25, Sonnet 3/15, Haiku 1/5 USD per million tokens, cache read x0.1, cache write
-- x1.25; any other model priced as Sonnet). The default table in code and this CASE must stay in step; a test replays
-- the events and compares the rows.
INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, card_id, phase_id, kind, model,
                         tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost_usd_micros, ended_at)
SELECT s.id, s.org_id, s.agent_id,
       COALESCE(s.project_id, c.project_id, bt.project_id), s.card_id, bt.phase_id, s.kind, s.model,
       COALESCE(s.tokens_input, 0), COALESCE(s.tokens_output, 0),
       COALESCE(s.tokens_cache_read, 0), COALESCE(s.tokens_cache_write, 0),
       round(
         COALESCE(s.tokens_input, 0)       * (CASE WHEN lower(s.model) LIKE '%opus%' THEN 5    WHEN lower(s.model) LIKE '%haiku%' THEN 1    ELSE 3    END)
       + COALESCE(s.tokens_output, 0)      * (CASE WHEN lower(s.model) LIKE '%opus%' THEN 25   WHEN lower(s.model) LIKE '%haiku%' THEN 5    ELSE 15   END)
       + COALESCE(s.tokens_cache_read, 0)  * (CASE WHEN lower(s.model) LIKE '%opus%' THEN 0.5  WHEN lower(s.model) LIKE '%haiku%' THEN 0.1  ELSE 0.3  END)
       + COALESCE(s.tokens_cache_write, 0) * (CASE WHEN lower(s.model) LIKE '%opus%' THEN 6.25 WHEN lower(s.model) LIKE '%haiku%' THEN 1.25 ELSE 3.75 END)
       )::bigint,
       s.ended_at
  FROM shifts s
  LEFT JOIN cards c ON c.id = s.card_id
  LEFT JOIN ba_tasks bt ON bt.id = s.ba_task_id
 WHERE s.status = 'ended' AND s.ended_at IS NOT NULL
ON CONFLICT (shift_id) DO NOTHING;
