-- Approval steps (#16): the card's approval state (approver, desk item, last decision, send-back count), a projection
-- of the ApprovalRequested / ApprovalDecided events.
ALTER TABLE cards ADD COLUMN approval jsonb;
