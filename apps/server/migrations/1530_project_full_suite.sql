-- Per-project switch for the automatic "Full E2E suite after <card>" regression card spawned when a card is finalized
-- (default on; projection of ProjectFullSuiteSet).
ALTER TABLE projects ADD COLUMN full_suite_after_finalize boolean NOT NULL DEFAULT true;
