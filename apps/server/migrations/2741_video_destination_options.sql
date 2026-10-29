-- Choices a destination needs from the owner at scheduling time (TikTok: privacy, interactions, disclosure, consent).
-- Projection column of VideoPostScheduled.destinationOptions. Safe to run again.
ALTER TABLE video_posts ADD COLUMN IF NOT EXISTS destination_options jsonb;

-- When the system moved the post to a later slot because it was not rendered in time (shown as an alert; cleared by a move).
ALTER TABLE video_posts ADD COLUMN IF NOT EXISTS slipped_at timestamptz;
