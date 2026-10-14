-- Suite results of the tester's integration and E2E tests (backlog #59, docs/design/run-and-integration-tests.md 4.6).
-- Projection of TestSuiteReported: one row per `aom test suite` report, so a failure followed by a passing re-run shows
-- both (the last row per suite and shift is the one that counts for the verdict).
CREATE TABLE test_suite_results (
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL,
  project_id        uuid NOT NULL,
  card_id           uuid NOT NULL,
  shift_id          uuid NOT NULL,
  agent_id          uuid,
  suite             text NOT NULL,
  kind              text CHECK (kind IN ('integration','e2e')),
  env_mode          text CHECK (env_mode IN ('local','remote')),
  env_id            uuid,
  deploy_target_id  uuid,
  commit            text,
  status            text NOT NULL CHECK (status IN ('passed','failed','flaky','timeout','skipped')),
  passed            integer NOT NULL DEFAULT 0,
  failed            integer NOT NULL DEFAULT 0,
  skipped           integer NOT NULL DEFAULT 0,
  duration_ms       integer NOT NULL DEFAULT 0,
  attempts          integer NOT NULL DEFAULT 1,
  failures          jsonb NOT NULL DEFAULT '[]',
  attachment_id     uuid,
  note              text,
  event_seq         bigint,
  created_at        timestamptz NOT NULL
);
CREATE INDEX test_suite_results_card ON test_suite_results (card_id, created_at);
CREATE INDEX test_suite_results_shift ON test_suite_results (shift_id);
-- "flaky 3 or more times in 7 days" per project and suite
CREATE INDEX test_suite_results_flaky ON test_suite_results (project_id, suite, created_at) WHERE status = 'flaky';
