-- Why the last working-branch sync left the branch unchanged (null: it was updated, or an older runner sent it).
ALTER TABLE repo_sync_status ADD COLUMN reason text, ADD COLUMN reason_message text;
