-- Lean Team v3, stream S1a (questions, routing, dependencies, affinity, stop-loss). All additive.

-- A question remembers the topic the asker named (routing on later steps), the stage its card was in when it was
-- asked (the repeat guard keys on card + stage) and, for a merged duplicate, the question it was attached to (the
-- asker's `question.status` poll follows it).
ALTER TABLE desk_items ADD COLUMN IF NOT EXISTS topic text;
ALTER TABLE desk_items ADD COLUMN IF NOT EXISTS stage text;
ALTER TABLE desk_items ADD COLUMN IF NOT EXISTS merged_into uuid;
-- An answer that keeps the card parked: the condition (free text) it waits for.
ALTER TABLE desk_items ADD COLUMN IF NOT EXISTS keep_blocked_until text;
CREATE INDEX IF NOT EXISTS desk_items_card_question_idx ON desk_items (card_id, created_at) WHERE kind = 'question';

-- Card affinity: only this agent may claim the card until `affinity_until`, and the dispatcher offers it before new work.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS affinity_agent_id uuid;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS affinity_session_id text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS affinity_until timestamptz;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS affinity_reason text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS affinity_desk_item_id uuid;

-- The project's stop-loss budget by card size (NULL: the defaults of the design).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS stop_loss jsonb;
