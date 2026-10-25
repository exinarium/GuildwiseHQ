-- Settings the platform administrator edits for the whole installation (notification addresses, the platform team,
-- runner pins). The table used to be created by the hosted support migration (1320); the core owns it now so a
-- self-hosted database has it before the migrations that read it (1400, 1590, 2160). Identical to the original
-- definition and safe to run again: a database that already has the table is untouched.
CREATE TABLE IF NOT EXISTS platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL
);
