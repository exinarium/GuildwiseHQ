-- `DeliveryRecipeReset` remembers every content hash that was cleared (the observed one and the approved one can differ), so a vault
-- sync of either does not bring the setup back; a different save starts fresh. Replaces the single `reset_hash` for new resets.
ALTER TABLE delivery_recipes ADD COLUMN reset_hashes text[] NOT NULL DEFAULT '{}';
UPDATE delivery_recipes SET reset_hashes = ARRAY[reset_hash] WHERE reset_hash IS NOT NULL;
