-- The first-login tour (UserTourStateChanged): where each user is in it. NULL means never shown (the server's AOM_TOUR_AUTOSTART decides whether that starts the tour); 'new' says so explicitly. Everyone who exists
-- when this migration runs has already found their way around, so they start with the tour completed (a rebuild of
-- the projections keeps that for users with no tour event).
ALTER TABLE users ADD COLUMN tour_status text CHECK (tour_status IN ('new','in_progress','completed','dismissed'));
ALTER TABLE users ADD COLUMN tour_step int NOT NULL DEFAULT 0;
UPDATE users SET tour_status = 'completed' WHERE tour_status IS NULL;
