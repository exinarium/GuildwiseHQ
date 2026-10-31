-- The project's local test services (loopback host and port that build, review and test shifts may reach from their
-- sandbox). Empty by default: nothing changes for a project that declares none. Safe to run again.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS test_services jsonb NOT NULL DEFAULT '[]'::jsonb;
