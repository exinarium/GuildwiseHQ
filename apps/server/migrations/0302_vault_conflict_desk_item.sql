-- The desk item that escalates a sync conflict, so resolving the item can resume syncing.
ALTER TABLE workstation_vaults ADD COLUMN desk_item_id uuid;
