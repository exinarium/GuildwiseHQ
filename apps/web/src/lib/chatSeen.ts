/** Which chats have unread agent replies: the time the reader last saw each chat, kept in localStorage. */
const key = (threadId: string) => `aom.chatSeen.${threadId}`;

export function markChatSeen(threadId: string, iso: string): void {
  try {
    localStorage.setItem(key(threadId), iso);
  } catch {
    /* storage blocked: unread dots just stay off */
  }
}

export function lastSeen(threadId: string): string | null {
  try {
    return localStorage.getItem(key(threadId));
  } catch {
    return null;
  }
}

/**
 * Unread = the newest message is from the agent, is newer than the last time the reader had the chat open, and the
 * reader has opened it before (a chat never opened is "new", not "unread", to avoid a dot on every old chat).
 */
export function isUnread(
  threadId: string,
  lastMessageAt: string | null,
  lastAuthorKind?: string | null,
): boolean {
  if (!lastMessageAt || lastAuthorKind !== 'agent') return false;
  const seen = lastSeen(threadId);
  return seen !== null && seen < lastMessageAt;
}
