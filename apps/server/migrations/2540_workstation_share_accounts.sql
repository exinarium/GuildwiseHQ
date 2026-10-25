-- A project's named account (a choice by the project's owner or manager) spends the keys and logins of the WORKSTATION OWNER.
-- Off by default: a project the workstation owner is not a member of cannot name a named account on that workstation unless the
-- owner switched "Allow projects to use my accounts" on. Projects the owner is a member of are not affected.
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS share_accounts boolean NOT NULL DEFAULT false;
