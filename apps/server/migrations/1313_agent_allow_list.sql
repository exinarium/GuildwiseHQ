-- Agents belong to the organization (docs/design/restructure.md, Part A). `project_id` becomes `hired_for_project_id`
-- (history only). Where an agent may work is a per-agent allow-list of projects (NULL = any project of the
-- organization), with a soft preference ("focus") inside it. A project may cap the shifts running at once.
-- Safe to run again: every step checks what is already there, and the backfill runs only when the column is added,
-- so it never overwrites an allow-list a manager set later.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'project_id') THEN
    ALTER TABLE agents RENAME COLUMN project_id TO hired_for_project_id;
  END IF;
  -- The id is history only: it stays on the agent after the project is deleted.
  ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_project_id_fkey;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'allowed_project_ids') THEN
    ALTER TABLE agents ADD COLUMN allowed_project_ids uuid[];            -- NULL = any project of the organization
    ALTER TABLE agents ADD COLUMN focus_project_ids uuid[] NOT NULL DEFAULT '{}';
    -- Project-scoped agents keep working their project only; org-wide agents may work any project.
    UPDATE agents SET allowed_project_ids = ARRAY[hired_for_project_id]
     WHERE hired_for_project_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM projects p WHERE p.id = agents.hired_for_project_id);
  END IF;
END $$;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS max_concurrent_shifts integer CHECK (max_concurrent_shifts IS NULL OR max_concurrent_shifts >= 1);
