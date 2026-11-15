-- Unit suites (handoff checks, 2026-11-15): the runner runs a suite card's unit suites and reports them as suite results
-- with kind 'unit'.
ALTER TABLE test_suite_results DROP CONSTRAINT IF EXISTS test_suite_results_kind_check;
ALTER TABLE test_suite_results ADD CONSTRAINT test_suite_results_kind_check
  CHECK (kind IN ('integration','e2e','unit'));
