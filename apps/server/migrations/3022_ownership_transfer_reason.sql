-- R17-3: the super admin's reason for a platform ownership transfer, kept with the pending request until the Owner
-- approves it (or the 7-day notice ends) and copied into `OrgOwnershipTransferred.reason` then; and the Owner whose
-- consent the request asks for (a request whose Owner has changed since is void, never automatic).
-- Numbered 3022 so it sorts after W14's 3021_release_artefacts.sql. The table is created here too (same definition
-- as 3020, IF NOT EXISTS) so this file applies on its own, whatever order a test or a partial schema runs it in.
CREATE TABLE IF NOT EXISTS org_ownership_transfers (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  to_user_id    uuid NOT NULL,
  requested_by  uuid NOT NULL,
  created_at    timestamptz NOT NULL,
  effective_at  timestamptz NOT NULL,
  decided_at    timestamptz,
  decision      text
);
ALTER TABLE org_ownership_transfers ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE org_ownership_transfers ADD COLUMN IF NOT EXISTS from_user_id uuid;
