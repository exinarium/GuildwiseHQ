-- Business mode (release 1.4.0): how an organization works. Every existing organization is 'dev'. Safe to run again.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'dev';
DO $$ BEGIN
  ALTER TABLE organizations ADD CONSTRAINT organizations_mode_check CHECK (mode IN ('dev','business'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
