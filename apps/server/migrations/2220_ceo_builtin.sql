-- The CEO is built in (docs/design/ceo-front-door.md step 0): one per organization, free of limits, not removable.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_builtin boolean NOT NULL DEFAULT false;
UPDATE agents SET is_builtin = true WHERE (is_devops OR role_key = 'ceo') AND NOT is_builtin;

-- At most one live CEO per organization (a retired one keeps its history). A database that already holds two live CEOs
-- (the appoint flow refused it, so none should) keeps the oldest: the others are retired first so the index can be built.
UPDATE agents a SET status = 'retired', retired_at = COALESCE(a.retired_at, now())
 WHERE a.role_key = 'ceo' AND a.status <> 'retired'
   AND EXISTS (SELECT 1 FROM agents b WHERE b.org_id = a.org_id AND b.role_key = 'ceo' AND b.status <> 'retired'
                 AND (b.hired_at, b.id) < (a.hired_at, a.id));
CREATE UNIQUE INDEX IF NOT EXISTS agents_one_ceo ON agents (org_id) WHERE role_key = 'ceo' AND status <> 'retired';
