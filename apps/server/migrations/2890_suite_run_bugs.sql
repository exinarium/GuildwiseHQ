-- Which bug cards a suite or regression run reported (filed, or an open one seen again) and their dedupe keys.
-- Projection of BugReported and RegressionBugSeenAgain. No foreign keys: a projection rebuild truncates cards.
-- The title key is `left('title:' || lower(btrim(regexp_replace(title, '\s+', ' ', 'g'))), 300)`, the same as the
-- projection (projections/testing.ts) and `titleKey` in @aom/shared.
CREATE TABLE IF NOT EXISTS suite_run_bugs (
  run_card_id uuid NOT NULL,
  bug_card_id uuid NOT NULL,
  failure_key text NOT NULL,
  title_key text NOT NULL,
  seen_again boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_card_id, bug_card_id)
);
CREATE INDEX IF NOT EXISTS suite_run_bugs_failure ON suite_run_bugs (failure_key);
CREATE INDEX IF NOT EXISTS suite_run_bugs_title ON suite_run_bugs (title_key);
CREATE INDEX IF NOT EXISTS suite_run_bugs_bug ON suite_run_bugs (bug_card_id);
-- Backfill from history, exactly as the projection derives it (a rebuild equals the migrated data).
INSERT INTO suite_run_bugs (run_card_id, bug_card_id, failure_key, title_key, seen_again, created_at)
SELECT COALESCE(e.payload->>'regressionCardId', e.payload->>'suiteCardId')::uuid, (e.payload->>'bugCardId')::uuid,
       COALESCE(e.payload->>'failureKey', k.key), k.key, false, e.created_at
  FROM events e,
       LATERAL (SELECT left('title:' || lower(btrim(regexp_replace(e.payload->>'title', '\s+', ' ', 'g'))), 300) AS key) k
 WHERE e.type = 'BugReported' AND COALESCE(e.payload->>'regressionCardId', e.payload->>'suiteCardId') IS NOT NULL
ON CONFLICT DO NOTHING;
