-- A project-wide run plan runs on another member's computer only after the owner of that computer allowed this version
-- (docs/design/deploy-run-ux-design.md section 14, v1a review).
CREATE TABLE run_plan_consents (
  plan_id         uuid NOT NULL,
  workstation_id  uuid NOT NULL,
  project_id      uuid NOT NULL,
  allowed_by      uuid NOT NULL,
  allowed_at      timestamptz NOT NULL,
  PRIMARY KEY (plan_id, workstation_id)
);
