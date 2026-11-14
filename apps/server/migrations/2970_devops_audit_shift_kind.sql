-- Which kind of shift a devops audit entry came from (a DevOps request or a release prep task). Null for chats and older runners.
ALTER TABLE devops_audit ADD COLUMN IF NOT EXISTS shift_kind text
  CHECK (shift_kind IS NULL OR shift_kind IN ('devops', 'release_prep'));
