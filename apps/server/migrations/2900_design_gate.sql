-- The design gate (code version 7): an owner approval of the design between Investigate & design and Build.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS design_gate boolean NOT NULL DEFAULT false;
-- The owner's switch for one card (only once the card has a design report).
ALTER TABLE cards ADD COLUMN IF NOT EXISTS design_gate_card boolean NOT NULL DEFAULT false;
-- Decided by the server at the design hand-off: does the card stop at the gate, why, and which high-risk paths.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS design_gate_required boolean;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS design_gate_reason text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS design_gate_paths text[] NOT NULL DEFAULT '{}';
