-- Run plans (backlog #58): the setup steps and services the DevOps engineer worked out for a project on one workstation,
-- saved by `aom run ready`. One active plan per project and workstation; older versions are kept as 'superseded'. The
-- plan lives in Guildwise, never in the repository. Projection of RunPlanSaved. (P1 records plans; replay comes later.)
CREATE TABLE run_plans (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL,
  project_id          uuid NOT NULL REFERENCES projects(id),
  workstation_id      uuid NOT NULL REFERENCES workstations(id),
  version             integer NOT NULL,
  status              text NOT NULL CHECK (status IN ('active','stale','superseded')),
  plan                jsonb NOT NULL,
  fingerprint         text NOT NULL,
  devops_request_id   uuid,
  saved_by_agent_id   uuid,
  created_at          timestamptz NOT NULL
);
CREATE UNIQUE INDEX run_plans_active ON run_plans (project_id, workstation_id) WHERE status <> 'superseded';
CREATE INDEX run_plans_project ON run_plans (project_id, workstation_id, version DESC);
