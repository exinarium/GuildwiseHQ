-- `DeliveryRecipeReset` (one-off operator reset for the new Environments page): the hash of the files that were cleared is
-- remembered so the same files are not observed again from the vault; a different save starts fresh.
ALTER TABLE delivery_recipes ADD COLUMN reset_hash text;
