-- R3c: each dispatch of a session turn to a workstation has an id, carried in chat.start and echoed in the frames of the
-- turn, so a late reply of an earlier dispatch is told from the current one. Null on rows from before.
ALTER TABLE session_turns ADD COLUMN IF NOT EXISTS attempt_id text;
