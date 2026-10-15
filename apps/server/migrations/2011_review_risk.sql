-- The reviewer's risk call on the card's current review round (backlog #70): { level, analysis, qaFocus }.
-- Set by ReviewApproved (the highest risk of the round's approvals), cleared by ReviewRequested.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS review_risk jsonb;
