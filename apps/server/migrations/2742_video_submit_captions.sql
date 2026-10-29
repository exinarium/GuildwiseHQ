-- Default captions per destination from the drafter (VideoPostSubmitted.captions). The captions the owner edited when
-- scheduling stay in video_posts.captions; unscheduling clears those (and the destination options) so the next Schedule
-- starts from these defaults again. Safe to run again.
ALTER TABLE video_posts ADD COLUMN IF NOT EXISTS submit_captions jsonb;
