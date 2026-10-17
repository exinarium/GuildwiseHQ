-- Measurement (Lean Team v3, stream S1b): the reason a runner turned a shift away is stored on the shift (projection of
-- ShiftEnded.rejectionReason), so a rejection storm can be read from the shifts table.
ALTER TABLE shifts ADD COLUMN rejection_reason text;
