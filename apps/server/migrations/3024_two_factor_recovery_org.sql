-- Release-readiness O2: an Owner's two-factor reset of a member remembers the organization and the Owner who asked, so
-- the scheduler re-checks the immediate path's rule (still the Owner, still a member, no access elsewhere) when the
-- 24-hour wait is over. A user's own recovery ("Lost your authenticator?") leaves both NULL.
ALTER TABLE two_factor_recoveries
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS requested_by uuid;

-- Open Owner resets scheduled before this change cannot be re-checked (no organization recorded): cancel them. Only an
-- Owner's reset is confirmed in the same instant it is created (scheduleOwnerTwoFactorReset); the Owner asks again.
UPDATE two_factor_recoveries SET cancelled_at = now()
 WHERE org_id IS NULL AND confirmed_at = created_at AND cancelled_at IS NULL AND done_at IS NULL;
