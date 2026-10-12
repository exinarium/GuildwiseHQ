-- Organisation source folders as the runner reports them (operational, replaced on each `org.folders` report; kept over a
-- projection rebuild). org_folders: [{orgId, folder, valid, reason, repoCount}]; org_folder_errors: {orgId: reason of the
-- last refused "set"}; org_folder_candidates: absolute folders the runner offers in the picker (bounded).
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS org_folders            jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS org_folder_errors      jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS org_folder_candidates  jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS org_folders_checked_at timestamptz;
