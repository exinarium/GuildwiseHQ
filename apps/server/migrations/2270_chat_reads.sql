-- Chats: the per-user read marker, synced across devices (replaces the browser-local "seen" times). `read_up_to` is the
-- creation time of the newest message the user has read; it only ever moves forward (ChatRead projection).
CREATE TABLE chat_reads (
  thread_id  uuid NOT NULL REFERENCES threads(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  read_up_to timestamptz NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
