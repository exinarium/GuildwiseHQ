-- "What's new in Guildwise HQ" (UserWhatsNewSeen): the ids of the release-note entries (file names under
-- apps/web/src/whats-new/entries) this user has seen, kept per user so the popup does not return on another device.
ALTER TABLE users ADD COLUMN whats_new_seen text[] NOT NULL DEFAULT '{}';
