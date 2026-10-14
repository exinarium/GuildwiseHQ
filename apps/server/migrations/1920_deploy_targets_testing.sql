-- Remote targets for the tester (backlog #59, phase 4, docs/design/run-and-integration-tests.md D7, 4.5). A deploy target can
-- be opted in to being tested: the tester's sandbox then reaches exactly its host(s). Projection columns of
-- DeployTargetAdded / DeployTargetUpdated.
ALTER TABLE deploy_targets
  ADD COLUMN test_enabled   boolean NOT NULL DEFAULT false,   -- the tester may test this target (needs app_url)
  ADD COLUMN production     boolean NOT NULL DEFAULT false,   -- a production target is never tested
  ADD COLUMN destructive_ok boolean NOT NULL DEFAULT false,   -- suites marked destructive may run against it
  ADD COLUMN test_hosts     text[]  NOT NULL DEFAULT '{}',    -- extra hostnames the tester may reach (a separate API host)
  ADD COLUMN secret_names   text[]  NOT NULL DEFAULT '{}',    -- names (never values) of the test accounts the tester gets
  ADD CONSTRAINT deploy_targets_no_production_tests CHECK (NOT (production AND test_enabled));

-- Which test-account secrets a workstation holds for a target: names and time only (operational; the values are encrypted
-- for the runner in the browser and never reach the server).
CREATE TABLE target_secret_status (
  -- no foreign keys: a projection rebuild truncates deploy_targets and workstations with CASCADE and must not take this along
  workstation_id uuid NOT NULL,
  target_id      uuid NOT NULL,
  name           text NOT NULL,
  set_at         timestamptz NOT NULL,
  set_by         uuid,
  PRIMARY KEY (workstation_id, target_id, name)
);
