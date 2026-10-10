-- The "Get started" checklist (UserSetupChecklistChanged): whether the user hid it. The steps themselves are computed
-- from real state on every read and are not stored.
ALTER TABLE users ADD COLUMN setup_checklist_dismissed boolean NOT NULL DEFAULT false;
