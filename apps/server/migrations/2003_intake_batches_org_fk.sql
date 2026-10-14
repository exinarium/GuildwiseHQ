-- Batch intake (#63) pointed intake_batches.org_id at users(id); it is an organisation id, so a batch in an
-- organisation whose id is not also a user id failed with a foreign-key error. Point it at organizations(id).
ALTER TABLE intake_batches DROP CONSTRAINT IF EXISTS intake_batches_org_id_fkey;
ALTER TABLE intake_batches
  ADD CONSTRAINT intake_batches_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED;
