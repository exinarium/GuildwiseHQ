-- Release prep tasks: work inside a prep step that an agent does in a 'release_prep' shift (Generate videos: the script
-- of a new video). One row per task; the step row it belongs to stays 'running' until its tasks are finished.
CREATE TABLE IF NOT EXISTS release_docs_prep_tasks (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES release_docs_prep_runs(id) ON DELETE CASCADE,
  repo_id uuid NOT NULL,
  step text NOT NULL,
  phase text NOT NULL DEFAULT '',
  position int NOT NULL DEFAULT 0,
  attempt int NOT NULL DEFAULT 0,
  task jsonb NOT NULL,
  workstation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  agent_id uuid,
  shift_id uuid,
  note text,
  commit_sha text,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS release_docs_prep_tasks_run ON release_docs_prep_tasks (run_id, repo_id, step, phase);
CREATE INDEX IF NOT EXISTS release_docs_prep_tasks_queued ON release_docs_prep_tasks (status) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS release_docs_prep_tasks_shift ON release_docs_prep_tasks (shift_id);

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS release_prep_task_id uuid;
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_kind_check;
ALTER TABLE shifts ADD CONSTRAINT shifts_kind_check
  CHECK (kind IN ('card','chat','question','devops','ba_task','ceo','release_prep'));
