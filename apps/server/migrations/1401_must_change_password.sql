-- An Owner can reset a member's password to a temporary one; the member must choose their own at next sign-in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
