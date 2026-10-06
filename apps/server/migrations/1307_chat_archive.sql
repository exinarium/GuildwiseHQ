-- Chats: Close (archive: hidden from the user's chat list, restorable from the Archived filter) is per user, because a
-- project chat is visible to several members. Delete is permanent: the thread keeps a tombstone row (deleted_at) so a
-- late runner message for it cannot break the projections, and its messages are removed.
CREATE TABLE chat_archives (
  thread_id   uuid NOT NULL REFERENCES threads(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  archived_at timestamptz NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);

ALTER TABLE threads ADD COLUMN deleted_at timestamptz;
