-- Two project settings (Lean Team v3, stream S1b). Projection of ProjectPolicySet.
--  decisions_project_only: answers and orders of this project (the platform project) stay at project scope; HR and the CEO
--    cannot promote them to the organization, the desk's org-wide switch is refused, HR clustering ignores its questions.
--  test_without_environment: a card may be tested without a test environment (replaces the "Test mode" and "Test
--    Environment" standing orders). Off: with no environment the card waits for DevOps.
ALTER TABLE projects
  ADD COLUMN decisions_project_only   boolean NOT NULL DEFAULT false,
  ADD COLUMN test_without_environment boolean NOT NULL DEFAULT false;
