-- The roles an organization runs (docs/bmad-roles.md): `guildwise` (the stock roles) or a role set such as `bmad`, and the
-- imported pack that holds the set's skills (`OrgRoleSetChanged`).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS role_set text NOT NULL DEFAULT 'guildwise';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS role_set_pack text;
