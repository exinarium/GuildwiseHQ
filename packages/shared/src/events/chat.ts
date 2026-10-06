import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

export const chatEvents = [
  /** A conversation between a user and one agent (`threads.kind = 'chat'`); messages are `ThreadMessagePosted(kind chat)`. */
  defineEvent(
    'ChatThreadCreated',
    z.object({
      threadId: Id,
      agentId: Id,
      projectId: Id.optional(),
      cardId: Id.optional(),
      title: z.string().min(1),
      createdBy: Id,
    }),
  ),
  /** Close: the user hides the chat from their list (per user; the conversation is kept). */
  defineEvent('ChatArchived', z.object({ threadId: Id, userId: Id })),
  /** Restore a closed chat to the user's list. */
  defineEvent('ChatRestored', z.object({ threadId: Id, userId: Id })),
  /** Delete: permanent. Only the creator, and not for a chat linked to a card (its messages are card history). */
  defineEvent('ChatDeleted', z.object({ threadId: Id, deletedBy: Id })),
] as const;
