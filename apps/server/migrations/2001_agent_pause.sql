-- Agent pause and resume (the CEO needs it; managers get the same buttons). A paused agent takes no new work; a running
-- shift finishes. Projection of AgentPaused / AgentResumed.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS paused_by uuid;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS pause_reason text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS paused_via_ceo boolean NOT NULL DEFAULT false;
