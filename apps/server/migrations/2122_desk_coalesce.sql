-- Repeated desk items about one subject are one item with a counter (Lean Team v3, stream S1b). `subject_key` identifies
-- the subject (set by DeskItemCreated.subjectKey), `repeat_count` counts how often it was raised while open
-- (projection of DeskItemRepeated).
ALTER TABLE desk_items
  ADD COLUMN subject_key       text,
  ADD COLUMN repeat_count      integer NOT NULL DEFAULT 1,
  ADD COLUMN last_repeated_at  timestamptz;
CREATE INDEX desk_items_subject ON desk_items (org_id, subject_key) WHERE subject_key IS NOT NULL AND status = 'open';
