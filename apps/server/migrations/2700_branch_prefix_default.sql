-- New projects get the card branch prefix `guildwise/` (the product used to be called aom). Only the column default
-- changes: the stored prefix of every existing project is left as it is.
ALTER TABLE projects ALTER COLUMN branch_prefix SET DEFAULT 'guildwise/';
