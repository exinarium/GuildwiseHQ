-- Permanent project delete (docs/ARCHITECTURE.md section 5.2, ProjectDeleted). A retired agent keeps `project_id` as its
-- historical scope (HR stats, the firing record), so the column stays but no longer needs the project row to exist.
ALTER TABLE agents DROP CONSTRAINT agents_project_id_fkey;
