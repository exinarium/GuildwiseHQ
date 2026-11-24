-- Release-readiness O5: a seal over each session row (HMAC-SHA256 over id, user_id, expires_at, second_factor_at and
-- method, keyed from the two-factor key, never stored in the database). A row without a valid seal is refused and
-- deleted, so a row inserted or edited with SQL is not a session. Existing rows are not sealed (backfilling would bless
-- a row forged before the deploy): everyone signs in once after the upgrade.
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS mac text;
