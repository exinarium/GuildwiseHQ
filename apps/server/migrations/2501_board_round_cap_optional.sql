-- The boardroom round cap is optional and off by default: a saved room may have none (NULL).
ALTER TABLE board_rooms ALTER COLUMN round_cap DROP NOT NULL;
