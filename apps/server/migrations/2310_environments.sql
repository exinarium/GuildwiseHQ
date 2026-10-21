-- Environments page (docs/design/environments-ux.md section 13): a deploy follow-up of a phase may name an environment of the
-- guided setup instead of a deploy target. Old rows keep their target_id and work as before (the column is simply NULL).
ALTER TABLE phase_followups ADD COLUMN environment text;
