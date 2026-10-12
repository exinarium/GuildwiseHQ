-- Architect role, Investigate & design step and investigation-only cards (docs/design/architect-and-workflows.md).
-- Projection columns, rebuilt from events (CardCreated/CardUpdated, InvestigationReported, CardMainSynced,
-- ProjectArchitectSettingsSet).

-- Per card: run the Investigate & design stage; only investigate (no build); merge the latest main first (NULL follows the
-- project); the recorded report; what the "merge latest main first" step did.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS design_needed      boolean NOT NULL DEFAULT false;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS investigation_only boolean NOT NULL DEFAULT false;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS merge_main_first   boolean;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS investigation      jsonb;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS main_sync          jsonb;

-- Per project. The design step is off unless the project opts in (owner decision 2026-10-12); merging main first is on.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS design_step            boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS merge_main_first       boolean NOT NULL DEFAULT true;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS investigation_path     text    NOT NULL DEFAULT 'docs/investigations';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS investigation_location text    NOT NULL DEFAULT 'repo';
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_investigation_location_check;
ALTER TABLE projects ADD CONSTRAINT projects_investigation_location_check CHECK (investigation_location IN ('repo','vault'));

-- `none`: an investigation-only card whose report lives in the vault is finalized with no repository step.
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_finalize_action_check;
ALTER TABLE cards ADD CONSTRAINT cards_finalize_action_check CHECK (finalize_action IN ('pr','push_branch','merge','none'));
