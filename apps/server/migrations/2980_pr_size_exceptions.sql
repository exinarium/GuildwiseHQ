-- PR size exceptions: a request for an over-budget pull request to stay as one, its reason and its outcome. A projection
-- of the SizeException* events. due_at is fixed at the request (2 working days in the owner's time zone). No foreign keys.
CREATE TABLE IF NOT EXISTS pr_size_exceptions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  project_repo_id uuid NOT NULL,
  pr_review_id uuid NOT NULL,
  chain_pr_review_ids uuid[] NOT NULL DEFAULT '{}',
  size integer NOT NULL,
  budget integer NOT NULL,
  unit text NOT NULL,
  members jsonb NOT NULL DEFAULT '[]',
  reason text NOT NULL CHECK (length(btrim(reason)) >= 20),
  state text NOT NULL,
  owner_user_id uuid NOT NULL,
  requested_by_agent_id uuid,
  desk_item_id uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by uuid,
  note text
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_size_exceptions_one_pending ON pr_size_exceptions (pr_review_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS pr_size_exceptions_due ON pr_size_exceptions (due_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS pr_size_exceptions_project ON pr_size_exceptions (project_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS pr_size_exceptions_chain ON pr_size_exceptions USING gin (chain_pr_review_ids);
