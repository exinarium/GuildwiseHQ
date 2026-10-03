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
] as const;
