CREATE TABLE cards (
  id                       uuid PRIMARY KEY,
  org_id                   uuid NOT NULL REFERENCES users(id),
  project_id               uuid NOT NULL REFERENCES projects(id),
  number                   integer NOT NULL,
  ref                      text NOT NULL,                      -- WEB-12
  title                    text NOT NULL,
  card_type                text NOT NULL CHECK (card_type IN ('feature','bug','support','refactor','docs','research','feed','regression')),
  workflow_version_id      uuid NOT NULL REFERENCES workflow_versions(id),  -- pinned at creation
  stage                    text NOT NULL,
  status                   text NOT NULL CHECK (status IN ('draft','queued','claimed','blocked','waiting','done','cancelled')),
  fields                   jsonb NOT NULL DEFAULT '{}',        -- workflow field schema (shared/cards/fields.ts)
  owner_user_id            uuid NOT NULL REFERENCES users(id),
  decision_policy          text NOT NULL DEFAULT 'owner_only' CHECK (decision_policy IN ('owner_only','any_manager')),
  risk_tier                text CHECK (risk_tier IN ('small','large')),
  risk_tier_overridden     boolean NOT NULL DEFAULT false,
  docs_needed              boolean NOT NULL DEFAULT false,
  completion_action        text CHECK (completion_action IN ('pr','push_branch','merge')),
  repo_id                  uuid REFERENCES project_repos(id),
  base_branch              text,
  branch_name              text,
  worktree_path            text,
  home_workstation_id      uuid REFERENCES workstations(id),   -- set on first claim that creates the worktree
  worktree_card_id         uuid REFERENCES cards(id),          -- bug child shares parent's worktree
  parent_card_id           uuid REFERENCES cards(id),
  origin                   text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','intake','schedule','test_failure','full_suite','regression')),
  scheduled                boolean NOT NULL DEFAULT false,
  schedule_id              uuid,
  priority                 smallint NOT NULL DEFAULT 2,        -- within project, 1 = highest
  rework_round             integer NOT NULL DEFAULT 0,
  is_rework_or_bug         boolean GENERATED ALWAYS AS (rework_round > 0 OR card_type = 'bug') STORED,
  original_builder_agent_id uuid REFERENCES agents(id),
  last_agent_id            uuid REFERENCES agents(id),
  excluded_agent_ids       uuid[] NOT NULL DEFAULT '{}',       -- agents not allowed to claim current stage
  review_approvals         smallint NOT NULL DEFAULT 0,        -- approvals in current review round
  required_capabilities    text[] NOT NULL DEFAULT '{}',
  -- claim / lease
  claim_id                 uuid,
  claimed_by_agent_id      uuid REFERENCES agents(id),
  claim_workstation_id     uuid REFERENCES workstations(id),
  claim_shift_id           uuid,
  claimed_at               timestamptz,
  lease_expires_at         timestamptz,                        -- refreshed by heartbeat (operational)
  claim_overflow           boolean NOT NULL DEFAULT false,
  queued_at                timestamptz,
  blocked_since            timestamptz,
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  finalized_at             timestamptz,
  UNIQUE (project_id, number),
  CHECK ((claim_id IS NULL) = (claimed_by_agent_id IS NULL))
);
CREATE INDEX cards_queue    ON cards (stage, queued_at) WHERE status = 'queued' AND claim_id IS NULL;
CREATE INDEX cards_project  ON cards (project_id, stage);
CREATE INDEX cards_claimed  ON cards (claimed_by_agent_id) WHERE claim_id IS NOT NULL;
CREATE INDEX cards_lease    ON cards (lease_expires_at) WHERE claim_id IS NOT NULL;

CREATE TABLE card_dependencies (
  card_id            uuid NOT NULL REFERENCES cards(id),
  depends_on_card_id uuid NOT NULL REFERENCES cards(id),
  PRIMARY KEY (card_id, depends_on_card_id),
  CHECK (card_id <> depends_on_card_id)
);

CREATE TABLE card_handoffs (
  id         uuid PRIMARY KEY,
  card_id    uuid NOT NULL REFERENCES cards(id),
  shift_id   uuid,
  agent_id   uuid REFERENCES agents(id),
  stage      text NOT NULL,
  outcome    text NOT NULL,
  note       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',      -- diffStats, score, reasons, evidence, ...
  event_seq  bigint NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX card_handoffs_card ON card_handoffs (card_id, created_at);

CREATE TABLE card_transitions (                 -- assignee history + metrics source
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id     uuid NOT NULL REFERENCES cards(id),
  from_stage  text, to_stage text NOT NULL,
  from_status text, to_status text NOT NULL,
  agent_id    uuid REFERENCES agents(id),
  user_id     uuid REFERENCES users(id),
  reason      text NOT NULL,                     -- event type
  event_seq   bigint NOT NULL,
  at          timestamptz NOT NULL
);
CREATE INDEX card_transitions_card ON card_transitions (card_id, id);
