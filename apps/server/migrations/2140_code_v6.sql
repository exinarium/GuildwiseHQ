-- Lean Team v3, stream S3: workflow code-v6. All additive.

-- A server-run stage (the test deploy): kind 'server'; a stage that starts only on a prepared environment (env_strict).
ALTER TABLE workflow_stages DROP CONSTRAINT IF EXISTS workflow_stages_kind_check;
ALTER TABLE workflow_stages ADD CONSTRAINT workflow_stages_kind_check
  CHECK (kind IN ('agent','manual','terminal','subworkflow','human','server'));
ALTER TABLE workflow_stages ADD COLUMN IF NOT EXISTS env_strict boolean NOT NULL DEFAULT false;

-- The card: group, Card Brief, the commit the branch is at, build evidence bound to it, the server-computed high-risk flag,
-- the owner approval decision, the approved commit, the test deploy result and a merge conflict resolution under review.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS group_id text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS card_brief text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS head_sha text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS build_evidence jsonb;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS high_risk boolean NOT NULL DEFAULT false;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS high_risk_paths jsonb;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS owner_approval_required boolean;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS owner_approval_reason text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS owner_approved_sha text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS test_deploy_state text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS merge_review jsonb;
CREATE INDEX IF NOT EXISTS cards_group_idx ON cards (project_id, group_id) WHERE group_id IS NOT NULL;

-- The first builder of a group keeps the rest of the group (hard dispatch clause) until `until`.
CREATE TABLE IF NOT EXISTS card_groups (
  project_id uuid NOT NULL,
  group_id text NOT NULL,
  builder_agent_id uuid NOT NULL,
  last_card_id uuid,
  until timestamptz NOT NULL,
  assigned_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, group_id)
);

-- The diff the runner uploaded at the review handoff, for the owner approval's diff view (written with the handoff, not
-- rebuilt from events: it is derived data and can be large).
CREATE TABLE IF NOT EXISTS card_diffs (
  card_id uuid PRIMARY KEY,
  sha text NOT NULL,
  base text NOT NULL DEFAULT '',
  body text NOT NULL,
  bytes integer NOT NULL,
  truncated boolean NOT NULL DEFAULT false,
  files integer NOT NULL DEFAULT 0,
  paths jsonb,
  created_at timestamptz NOT NULL
);

-- The commit a card shift started at (the review shifts are checked against the build evidence).
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS start_sha text;

-- Project settings: when the owner approves (default: large and high-risk cards) and the changed-path to E2E spec mapping.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_approval_policy text NOT NULL DEFAULT 'large_or_high_risk';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS e2e_areas jsonb;
