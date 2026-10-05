-- DevOps repository hygiene and the working branch (docs/design/phases.md, addendum of 2026-10-05).

-- The hygiene schedule of a workstation: hours between runs (0 = off; owner decision 1: daily) and when the last one
-- was requested. Projections of WorkstationHygieneChanged / DevOpsRequested{hygiene}.
ALTER TABLE workstations
  ADD COLUMN hygiene_interval_hours integer NOT NULL DEFAULT 24 CHECK (hygiene_interval_hours >= 0),
  ADD COLUMN hygiene_last_at        timestamptz;

-- The repositories a hygiene request covers (a snapshot: the HygieneSpec of the DevOpsRequested event).
ALTER TABLE devops_requests ADD COLUMN hygiene jsonb;
CREATE INDEX devops_requests_hygiene ON devops_requests (workstation_id, created_at DESC) WHERE hygiene IS NOT NULL;

-- Who confirmed the repository's working branch, and when (project_repos.working_branch is NULL until confirmed).
ALTER TABLE project_repos
  ADD COLUMN working_branch_set_by uuid,
  ADD COLUMN working_branch_set_at timestamptz,
  ADD COLUMN known_branches        jsonb NOT NULL DEFAULT '[]';   -- branches of the clone, from the last hygiene run

-- What the last hygiene runs could not resolve (conflicts, a dirty tree on another branch, auth failures, worktrees of
-- dead cards with uncommitted changes). One open finding per subject (a repository or a worktree path) and kind; the
-- BA reporter turns the open ones into signals and they close when a later run finds the subject in order.
CREATE TABLE hygiene_findings (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES users(id),
  workstation_id uuid NOT NULL REFERENCES workstations(id),
  project_id     uuid,
  subject        text NOT NULL,                 -- project_repos.id, or the worktree path
  subject_name   text NOT NULL,                 -- repository name or worktree path, for display
  kind           text NOT NULL,                 -- HygieneProblemKind | 'dirty_worktree'
  detail         text NOT NULL DEFAULT '',
  files          jsonb NOT NULL DEFAULT '[]',
  request_id     uuid,
  status         text NOT NULL CHECK (status IN ('open','resolved')),
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  resolved_at    timestamptz
);
CREATE UNIQUE INDEX hygiene_findings_open ON hygiene_findings (workstation_id, subject, kind) WHERE status = 'open';
CREATE INDEX hygiene_findings_org ON hygiene_findings (org_id) WHERE status = 'open';
