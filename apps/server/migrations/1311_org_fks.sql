-- Re-point every `org_id` foreign key from users(id) to organizations(id) (docs/design/organizations.md section 2.2).
-- The constraints are DEFERRABLE INITIALLY DEFERRED so a projection rebuild (one transaction) can replay a legacy
-- `ProjectCreated` before the late `OrganizationCreated` event, and NOT VALID because `organizations` is still empty
-- on an upgrade: the data migration `orgs-2026-10` creates the organizations and then validates every constraint.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conrelid::regclass AS tbl, con.conname AS name
      FROM pg_constraint con
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
     WHERE con.contype = 'f' AND con.confrelid = 'users'::regclass AND att.attname = 'org_id'
       AND con.connamespace = current_schema()::regnamespace
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.name);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (org_id) REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED NOT VALID',
      c.tbl, c.name);
  END LOOP;
END $$;
