-- Guided run steps and "Scan with DevOps" (docs/design/deploy-run-ux-design.md sections 5 and 7).
-- Run plans: a plan may now belong to the whole project (workstation_id NULL, saved by the owner or from a confirmed
-- scan), remember who wrote it (`source`; every older row is a DevOps plan) and flag its last failed start without going
-- stale. At most one non-superseded plan per (project, workstation) and one project-wide plan.
ALTER TABLE run_plans ALTER COLUMN workstation_id DROP NOT NULL;
ALTER TABLE run_plans ADD COLUMN source text NOT NULL DEFAULT 'devops' CHECK (source IN ('devops','owner','scan'));
ALTER TABLE run_plans ADD COLUMN saved_by uuid;
ALTER TABLE run_plans ADD COLUMN proposal_id uuid;
ALTER TABLE run_plans ADD COLUMN last_failure jsonb;
DROP INDEX run_plans_active;
CREATE UNIQUE INDEX run_plans_active ON run_plans (project_id, COALESCE(workstation_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status <> 'superseded';

-- Proposals of a scan (SetupProposalSubmitted / SetupProposalResolved): what DevOps found, until a person decides.
CREATE TABLE setup_proposals (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL,
  area            text NOT NULL CHECK (area IN ('run','deploy')),
  request_id      uuid NOT NULL,
  workstation_id  uuid NOT NULL,
  proposal        jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed','superseded')),
  submitted_at    timestamptz NOT NULL,
  resolved_at     timestamptz,
  resolved_by     uuid
);
CREATE INDEX setup_proposals_project ON setup_proposals (project_id, area, submitted_at DESC);

-- A local Docker target may name the workstation it runs on ("on this computer"); only a remote host must have one.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'deploy_targets'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%remote_ssh%' AND pg_get_constraintdef(oid) LIKE '%workstation_id IS NOT NULL%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE deploy_targets DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE deploy_targets ADD CONSTRAINT deploy_targets_remote_has_workstation
  CHECK (kind <> 'remote_ssh' OR workstation_id IS NOT NULL);
