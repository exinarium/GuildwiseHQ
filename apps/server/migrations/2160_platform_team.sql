-- Platform team (Lean Team v3, stream S4). The designated organisation and project live in platform_settings
-- ('platform.team'); everything below is either a projection of PlatformPause* events (platform_pauses) or an operational
-- record that cannot be rebuilt from events (bugs, deploy audit, approvals, grants, runner pins). No foreign keys to
-- projection tables: a projection rebuild must not empty them.

-- Pauses scoped to what a bug hits: every given column must match the card (project, workflow, stage) or the shift's
-- workstation. Projection of PlatformPauseStarted / PlatformPauseEnded.
CREATE TABLE IF NOT EXISTS platform_pauses (
  id              uuid PRIMARY KEY,
  project_id      uuid,
  workflow_key    text,
  stage_id        text,
  workstation_id  uuid,
  reason          text NOT NULL,
  source          text NOT NULL CHECK (source IN ('auto', 'manual')),
  severity        text NOT NULL DEFAULT 'critical',
  bug_signature   text,
  bug_card_id     uuid,
  created_by      uuid,
  created_at      timestamptz NOT NULL,
  resumed_at      timestamptz,
  resume_reason   text,
  resumed_by      text,
  CHECK (project_id IS NOT NULL OR workflow_key IS NOT NULL OR stage_id IS NOT NULL OR workstation_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS platform_pauses_open ON platform_pauses (created_at) WHERE resumed_at IS NULL;
CREATE INDEX IF NOT EXISTS platform_pauses_bug ON platform_pauses (bug_card_id) WHERE resumed_at IS NULL;

-- One row per bug signature: the dedupe key of bug intake, with the occurrence counter and the sanitised diagnostics.
CREATE TABLE IF NOT EXISTS platform_bugs (
  signature        text PRIMARY KEY,
  source           text NOT NULL,
  title            text NOT NULL,
  severity         text NOT NULL DEFAULT 'unrated' CHECK (severity IN ('unrated', 'critical', 'degraded', 'minor')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'invalid')),
  fix_size         text NOT NULL DEFAULT 'medium' CHECK (fix_size IN ('small', 'medium', 'large')),
  occurrences      integer NOT NULL DEFAULT 1,
  card_id          uuid,
  project_id       uuid,                      -- the platform project the card lives in
  client_org_id    uuid,                      -- the organisation the bug hit (null: the platform itself)
  scope            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- what a pause would cover: {projectId, workflowKey, stageId, workstationId}
  diagnostics      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- sanitised: signature, top frames, counts, versions
  extended         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- more detail, visible only through an active grant (audited)
  severity_by      text NOT NULL DEFAULT 'rules' CHECK (severity_by IN ('rules', 'architect', 'manager')),
  filed_at         timestamptz,                          -- when the bug card was created (rate limit)
  fixed_cards      text[] NOT NULL DEFAULT '{}',         -- refs of earlier cards of this signature (a regression files a new card)
  stop_loss_level  integer NOT NULL DEFAULT 0,           -- 0 within budget, 1 architect arbitration, 2 owner
  budget_extra     integer NOT NULL DEFAULT 0,           -- extra budgets granted by arbitration or the owner
  stop_loss_desk_item_id uuid,                           -- the owner's decision on the platform organisation's desk
  notified_count   integer NOT NULL DEFAULT 0,           -- the highest counter milestone already noted on the card
  first_seen_at    timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_bugs_open ON platform_bugs (last_seen_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS platform_bugs_card ON platform_bugs (card_id) WHERE card_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_bugs_unfiled ON platform_bugs (created_at) WHERE card_id IS NULL AND status = 'open';

-- Each piece of evidence counts once (a loop on one card is one occurrence however often the detector sees it).
CREATE TABLE IF NOT EXISTS platform_bug_hits (
  signature     text NOT NULL REFERENCES platform_bugs(signature) ON DELETE CASCADE,
  evidence_key  text NOT NULL,
  at            timestamptz NOT NULL,
  PRIMARY KEY (signature, evidence_key)
);

-- The deploy audit trail: every check and every recorded deploy (who approved, what risk, how to roll back).
CREATE TABLE IF NOT EXISTS platform_deploy_audit (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('check', 'deploy', 'approval', 'rollback')),
  version         text NOT NULL,
  from_version    text,
  risk            text NOT NULL CHECK (risk IN ('low', 'high')),
  risk_categories text[] NOT NULL DEFAULT '{}',
  risk_paths      text[] NOT NULL DEFAULT '{}',
  downtime        boolean NOT NULL DEFAULT false,
  allowed         boolean,
  outcome         text,
  bug_card_id     uuid,
  fixes_pausing   boolean NOT NULL DEFAULT false,
  review_approved boolean,
  tests_passed    boolean,
  uat_passed      boolean,
  approved_by     text,
  rollback_path   text,
  diff_summary    text,
  reason          text,
  actor           text
);
CREATE INDEX IF NOT EXISTS platform_deploy_audit_at ON platform_deploy_audit (at DESC);

-- Approvals the platform organisation gives on its desk before a deploy (high risk, downtime), one per version and kind.
CREATE TABLE IF NOT EXISTS platform_deploy_approvals (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  version       text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('high_risk', 'downtime')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  desk_item_id  uuid,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at  timestamptz NOT NULL,
  decided_at    timestamptz,
  decided_by    uuid,
  note          text,
  UNIQUE (version, kind)
);

-- Grants: the platform team asks a client organisation to show more of one bug; time-boxed, audited, revocable.
CREATE TABLE IF NOT EXISTS platform_diag_grants (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  signature     text NOT NULL,
  bug_card_id   uuid,
  client_org_id uuid NOT NULL,
  requested_by  uuid NOT NULL,
  reason        text NOT NULL,
  hours         integer NOT NULL,
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'denied', 'revoked', 'expired')),
  desk_item_id  uuid,
  requested_at  timestamptz NOT NULL,
  decided_at    timestamptz,
  decided_by    uuid,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid
);
CREATE INDEX IF NOT EXISTS platform_diag_grants_sig ON platform_diag_grants (signature, status);

-- Every read of extended diagnostics under a grant.
CREATE TABLE IF NOT EXISTS platform_diag_access (
  id        bigserial PRIMARY KEY,
  grant_id  uuid NOT NULL REFERENCES platform_diag_grants(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL,
  at        timestamptz NOT NULL
);

-- Safe mode: a workstation pinned to a runner version (the all-workstations pin lives in platform_settings 'runners.version_pin').
CREATE TABLE IF NOT EXISTS workstation_runner_pins (
  workstation_id uuid PRIMARY KEY,
  version        text NOT NULL,
  reason         text,
  pinned_by      uuid,
  pinned_at      timestamptz NOT NULL
);
