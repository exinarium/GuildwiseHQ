-- Avatars. Agents get a generated cartoon face (the browser renders it from a seed and a style; nothing is fetched):
-- AgentHired carries the seed, "Re-roll face" is AgentAvatarRerolled. Agents hired before this migration get a face
-- seeded from their id (the projector uses the id when an AgentHired event has no seed, so a rebuild agrees).
ALTER TABLE agents ADD COLUMN avatar_seed text;
ALTER TABLE agents ADD COLUMN avatar_style text;
UPDATE agents SET avatar_seed = id::text, avatar_style = 'notionists' WHERE avatar_seed IS NULL;
ALTER TABLE agents ALTER COLUMN avatar_seed SET NOT NULL;
ALTER TABLE agents ALTER COLUMN avatar_style SET NOT NULL;
ALTER TABLE agents ALTER COLUMN avatar_style SET DEFAULT 'notionists';

-- A user's own picture (UserAvatarSet): a generated face or an uploaded image kept in avatar_images.
ALTER TABLE users ADD COLUMN avatar_kind text CHECK (avatar_kind IN ('cartoon','image'));
ALTER TABLE users ADD COLUMN avatar_seed text;
ALTER TABLE users ADD COLUMN avatar_style text;
ALTER TABLE users ADD COLUMN avatar_image_id uuid;

-- The uploaded pictures (a 256 px PNG each). Written by the command before its event, not by a projector, and with no
-- foreign key so a projection rebuild (which truncates `users`) cannot empty it.
CREATE TABLE avatar_images (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  mime       text NOT NULL,
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX avatar_images_user ON avatar_images (user_id);
