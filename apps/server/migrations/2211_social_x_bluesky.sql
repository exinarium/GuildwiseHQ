-- X and Bluesky sharing. social_channels and social_shares are OPERATIONAL (no foreign key to a projection), so this
-- only widens the allowed networks. X keys and the Bluesky handle and app password are stored as one encrypted JSON
-- string in access_token. Safe to run again.
ALTER TABLE social_channels DROP CONSTRAINT IF EXISTS social_channels_network_check;
ALTER TABLE social_channels ADD CONSTRAINT social_channels_network_check
  CHECK (network IN ('facebook','linkedin','x','bluesky'));
ALTER TABLE social_shares DROP CONSTRAINT IF EXISTS social_shares_network_check;
ALTER TABLE social_shares ADD CONSTRAINT social_shares_network_check
  CHECK (network IN ('facebook','linkedin','x','bluesky'));
