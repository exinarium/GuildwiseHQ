-- Views (release 1.4.0): Software or Business view is presentation only. `organizations.mode` stays as the organization's
-- default view; a member may override it for themselves per membership. NULL: follow the organization default.
-- Projected from OrgMemberViewSet (org_members is a projection table, so a rebuild restores it from the log).
ALTER TABLE org_members ADD COLUMN IF NOT EXISTS view text;
DO $$ BEGIN
  ALTER TABLE org_members ADD CONSTRAINT org_members_view_check CHECK (view IS NULL OR view IN ('dev','business'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
