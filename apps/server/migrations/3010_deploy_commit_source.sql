-- Which commit a deploy run builds and why: the source the commit was resolved from (the person's own, the newest shipped
-- release, what an earlier environment runs, the tip of the working branch, or a rollback) and a short detail.
-- Null on runs that were requested before this column existed.
ALTER TABLE deploy_runs
  ADD COLUMN IF NOT EXISTS commit_source text
    CHECK (commit_source IN ('explicit','release','promoted','working-branch','rollback')),
  ADD COLUMN IF NOT EXISTS commit_source_detail text;
