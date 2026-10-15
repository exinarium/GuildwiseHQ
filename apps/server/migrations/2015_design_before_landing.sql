-- Backlog #80: a design made before the card's dependencies landed is held in the design stage until they land, then
-- the architect reviews the recorded assumptions. {state: 'waiting'|'reviewed', dependencies: [ref], agentId, result}.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS design_review jsonb;
