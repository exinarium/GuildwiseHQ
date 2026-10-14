-- Desk items the CEO touched: the action that answered the item ("Answered by <CEO>"), and its recommendation.
ALTER TABLE desk_items ADD COLUMN IF NOT EXISTS ceo_action_id uuid;
ALTER TABLE desk_items ADD COLUMN IF NOT EXISTS ceo_recommendation jsonb;   -- {actionId, option, text, reason, confidence, at}
-- The CEO's chat shifts are priced as `ceo_chat`: no column needed (shift_costs.kind), the projector decides.
