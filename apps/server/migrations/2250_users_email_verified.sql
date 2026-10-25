-- Sign-in needs a verified email (commands/auth.ts). The column used to be added by the hosted sign-up migration
-- (1440); the core owns it now so a self-hosted database has it too. Accounts created by an administrator, an
-- invitation or the CLI are verified when they are created (projections/users.ts). Safe to run again, and it never
-- touches existing values: a database that already has the column keeps its rows as they are.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
