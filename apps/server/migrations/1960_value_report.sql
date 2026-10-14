-- Value report (backlog #37): the organization's estimate of human hours per finished card and the value of an hour,
-- set by the Owner or an Admin (OrgValueSettingsChanged). NULL = the defaults of packages/shared/src/api/value.ts.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS value_settings jsonb;
