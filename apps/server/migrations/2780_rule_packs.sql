-- Rule packs (business mode): built-in sets of standing orders an organization installs in one action.
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS rule_pack_id      text,
  ADD COLUMN IF NOT EXISTS rule_pack_rule_id text;

-- One live row per pack rule and organization: a second install finds it and adds nothing.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_rule_pack_live ON ledger_entries (org_id, rule_pack_id, rule_pack_rule_id)
  WHERE rule_pack_rule_id IS NOT NULL AND retired_at IS NULL AND superseded_by IS NULL;

-- Projection of RulePackInstalled / RulePackRemoved: which packs an organization has installed.
CREATE TABLE IF NOT EXISTS org_rule_packs (
  org_id        uuid NOT NULL,
  pack_id       text NOT NULL,
  pack_version  integer NOT NULL,
  installed_at  timestamptz NOT NULL,
  installed_by  uuid,
  removed_at    timestamptz,
  removed_by    uuid,
  PRIMARY KEY (org_id, pack_id)
);
