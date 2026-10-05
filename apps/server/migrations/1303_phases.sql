-- Named phases of a project, their post-phase follow-ups, deploy targets and the BA's background task queue
-- (docs/design/phases.md). Projections of the Phase*, DeployTarget*, ProjectFollowupDefaultsSet, CardPhaseChanged,
-- CardMergeVerified and BaTask* events.
ALTER TABLE projects
  ADD COLUMN next_phase_number integer NOT NULL DEFAULT 1,
  ADD COLUMN default_followups  jsonb   NOT NULL DEFAULT '[]';   -- FollowupSpec[] that pre-fills new phases

CREATE TABLE deploy_targets (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES users(id),
  project_id     uuid NOT NULL REFERENCES projects(id),
  name           text NOT NULL,                                   -- "local", "staging"
  kind           text NOT NULL CHECK (kind IN ('local_docker','remote_ssh')),
  -- remote_ssh: whose DevOps engineer deploys. local_docker: NULL, a deploy fans out to every workstation of every
  -- project member (owner decision A9).
  workstation_id uuid REFERENCES workstations(id),
  host           text,                                            -- remote_ssh: SSH host alias from ~/.ssh/config, no secrets
  app_url        text,                                            -- where the deployed app answers (testers use it)
  notes          text NOT NULL DEFAULT '',                        -- how to deploy: compose file, script, env name
  created_by     uuid NOT NULL REFERENCES users(id),
  removed_at     timestamptz,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  CHECK ((kind = 'remote_ssh') = (workstation_id IS NOT NULL))
);
CREATE UNIQUE INDEX deploy_targets_name ON deploy_targets (project_id, lower(name)) WHERE removed_at IS NULL;

CREATE TABLE phases (
  id                     uuid PRIMARY KEY,
  org_id                 uuid NOT NULL REFERENCES users(id),
  project_id             uuid NOT NULL REFERENCES projects(id),
  number                 integer NOT NULL,
  ref                    text NOT NULL,                           -- WEB-P2
  name                   text NOT NULL,
  description            text NOT NULL DEFAULT '',
  status                 text NOT NULL CHECK (status IN ('proposed','open','reporting','awaiting_approval',
                           'running_followups','reporting_results','done','done_with_failures',
                           'followups_rejected','discarded','cancelled')),
  -- The branch the phase's work must be merged into and deployed from; NULL: the repository's / project's working branch.
  working_branch         text,
  created_by_kind        text NOT NULL CHECK (created_by_kind IN ('user','agent')),
  created_by_user_id     uuid REFERENCES users(id),
  created_by_agent_id    uuid REFERENCES agents(id),
  intake_id              uuid REFERENCES intakes(id),             -- the intake the BA proposed it in
  proposal_desk_item_id  uuid,
  report_desk_item_id    uuid,                                    -- "phase done, approve follow-ups"
  results_desk_item_id   uuid,                                    -- "follow-ups finished"
  card_outcomes          jsonb NOT NULL DEFAULT '[]',             -- snapshot from PhaseCompleted
  report                 text,                                    -- BA summary (markdown)
  outstanding            jsonb NOT NULL DEFAULT '[]',             -- [{kind, text, cardId?, url?}]
  results_report         text,
  completed_at           timestamptz,
  approved_by            uuid REFERENCES users(id),
  approved_at            timestamptz,
  finished_at            timestamptz,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  UNIQUE (project_id, number)
);
CREATE UNIQUE INDEX phases_name ON phases (project_id, lower(name)) WHERE status NOT IN ('discarded','cancelled');
CREATE INDEX phases_active ON phases (status) WHERE status IN ('open','running_followups');

CREATE TABLE phase_followups (
  id                  uuid PRIMARY KEY,
  phase_id            uuid NOT NULL REFERENCES phases(id),
  position            integer NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('deploy','regression','custom')),
  target_id           uuid REFERENCES deploy_targets(id),       -- deploy: required; regression: optional (run against it)
  platform            text CHECK (platform IN ('web','mobile','both')),
  instruction         text NOT NULL DEFAULT '',                 -- custom: required
  note                text NOT NULL DEFAULT '',                 -- the manager's extra note for the delegate
  status              text NOT NULL CHECK (status IN ('pending','queued','briefed','running','succeeded','failed','skipped','cancelled')),
  delegate            text CHECK (delegate IN ('devops','tester','ba')),
  brief               text,                                     -- the delegation text the BA wrote
  devops_request_ids  uuid[] NOT NULL DEFAULT '{}',             -- a local deploy: one DevOps request per workstation
  regression_card_ids uuid[] NOT NULL DEFAULT '{}',
  ba_task_id          uuid,
  result_summary      text,
  evidence            jsonb NOT NULL DEFAULT '{}',
  mock                jsonb,                                    -- AOM_MOCK_UI only: script copied to regression cards
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  UNIQUE (phase_id, position) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE cards
  ADD COLUMN phase_id            uuid REFERENCES phases(id),
  ADD COLUMN phase_assignment    text CHECK (phase_assignment IN ('proposed','confirmed')),
  ADD COLUMN phase_followup_id   uuid,                         -- regression cards a follow-up created (never members)
  ADD COLUMN merged_into_working_at timestamptz;               -- the card's work is in the working branch (A2)
CREATE INDEX cards_phase ON cards (phase_id) WHERE phase_id IS NOT NULL;
ALTER TABLE cards ADD CONSTRAINT cards_phase_pair CHECK ((phase_id IS NULL) = (phase_assignment IS NULL));

-- BA background queue (non-card work: phase reports, follow-up briefs, custom follow-ups).
CREATE TABLE ba_tasks (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES users(id),
  project_id  uuid REFERENCES projects(id),
  phase_id    uuid REFERENCES phases(id),
  followup_id uuid REFERENCES phase_followups(id),
  kind        text NOT NULL CHECK (kind IN ('phase_report','followups_brief','followup_custom','followups_report')),
  status      text NOT NULL CHECK (status IN ('queued','running','done','failed','fallback','cancelled')),
  preferred_agent_id uuid REFERENCES agents(id),               -- the intake's BA, if any
  agent_id    uuid REFERENCES agents(id),                      -- set on dispatch
  shift_id    uuid,
  attempts    integer NOT NULL DEFAULT 0,
  note        text,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX ba_tasks_queue ON ba_tasks (created_at) WHERE status = 'queued';

ALTER TABLE shifts DROP CONSTRAINT shifts_kind_check;
ALTER TABLE shifts ADD CONSTRAINT shifts_kind_check CHECK (kind IN ('card','chat','question','devops','ba_task'));
ALTER TABLE shifts ADD COLUMN ba_task_id uuid;
CREATE INDEX shifts_ba_task ON shifts (ba_task_id) WHERE ba_task_id IS NOT NULL;

-- Phase threads (thread id = phase id): agent comments and system notes on follow-up progress.
ALTER TABLE threads DROP CONSTRAINT threads_kind_check;
ALTER TABLE threads ADD CONSTRAINT threads_kind_check CHECK (kind IN ('card','chat','devops','intake','phase'));
