-- Research is a stage, projects convert (docs/design/restructure.md Part C). A project remembers the workflow it was
-- created with (`started_as`, `research` for research-first projects: the Research tab stays for them), when it was
-- last converted and by whom, and a conversion that waits for repositories the owner still has to approve.
-- Projection of ProjectCreated / ProjectConverted / ProjectConversionRequested / ProjectConversionCancelled: a rebuild
-- reproduces every column. Safe to run again: columns are added once, and the backfill touches only rows without a value.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS started_as          text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS converted_at        timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS converted_by        uuid REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pending_conversion  jsonb;
-- What each project was created with comes from its own ProjectCreated event (a legacy PATCH of the workflow must not
-- rewrite history); a project whose event is gone (never in practice) falls back to its current workflow.
UPDATE projects p SET started_as = COALESCE(
    (SELECT e.payload->>'workflowKey' FROM events e
      WHERE e.stream_id = 'project-' || p.id::text AND e.type = 'ProjectCreated' ORDER BY e.seq LIMIT 1),
    p.workflow_key)
 WHERE p.started_as IS NULL;

-- Repository requests can come from the manager's convert dialog (no agent asked for them).
ALTER TABLE repo_requests ALTER COLUMN requested_by_agent_id DROP NOT NULL;
ALTER TABLE repo_requests ADD COLUMN IF NOT EXISTS requested_by_user_id uuid REFERENCES users(id);
