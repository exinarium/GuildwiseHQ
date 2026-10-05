-- Owner override: large-tier merges finalize without the manager's desk approval (default off; projection of
-- ProjectMergePolicyChanged, which records who changed it and when).
ALTER TABLE projects
  ADD COLUMN merge_large_without_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN merge_large_changed_by       uuid REFERENCES users(id),
  ADD COLUMN merge_large_changed_at       timestamptz;
