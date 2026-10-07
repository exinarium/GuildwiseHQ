-- Drop the work/personal domain: projects are ranked by their organization (drag and drop on the Projects page).
-- docs/design/open-questions.md "drop 'personal'; projects ranked by drag and drop".
--
-- What the columns held is kept in `legacy_project_domains` until the data migration `no-personal-2026-10` has used it
-- (it ranks the personal projects below the work ones and merges the personal vault into the organization vault); the
-- data migration drops the table when it is done. It is not a projection: a rebuild leaves it alone.
CREATE TABLE IF NOT EXISTS legacy_project_domains (
  project_id    uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  key           text NOT NULL,
  kind          text NOT NULL,
  domain        text NOT NULL,
  priority_tier smallint NOT NULL,
  created_at    timestamptz NOT NULL,
  vault_dir     text,
  vault_folder  text
);
INSERT INTO legacy_project_domains (project_id, org_id, key, kind, domain, priority_tier, created_at, vault_dir, vault_folder)
  SELECT id, org_id, key, kind, domain, priority_tier, created_at, vault_dir, vault_folder FROM projects
  ON CONFLICT (project_id) DO NOTHING;

-- The rank: 1 = most important. Interest projects have none. Until the data migration appends `ProjectsRanked`, the order
-- is the old one (work before personal, then the priority tier, then age), so the dispatcher keeps its behaviour.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS rank integer;
UPDATE projects p SET rank = r.n
  FROM (SELECT id, row_number() OVER (PARTITION BY org_id ORDER BY (domain = 'work') DESC, priority_tier, created_at, id)::int AS n
          FROM projects WHERE kind = 'project') r
 WHERE p.id = r.id AND p.rank IS NULL;
CREATE INDEX IF NOT EXISTS projects_rank ON projects (org_id, rank) WHERE kind = 'project';

ALTER TABLE projects DROP COLUMN IF EXISTS domain;
ALTER TABLE projects DROP COLUMN IF EXISTS priority_tier;
ALTER TABLE interests DROP COLUMN IF EXISTS domain;

-- Vaults: `work` is the organization vault (`org`). A `personal` vault stays until the data migration merged it.
ALTER TABLE vaults DROP CONSTRAINT IF EXISTS vaults_kind_check;
UPDATE vaults SET kind = 'org' WHERE kind = 'work';
ALTER TABLE vaults ADD CONSTRAINT vaults_kind_check CHECK (kind IN ('org','personal','project'));
