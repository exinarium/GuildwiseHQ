import { z } from 'zod';
import { ThreadMessageDtoSchema } from './cards.ts';
import { IsoTime } from './common.ts';

/** `GET /api/threads/:id/messages?before=&limit=`: newest-first paging, returned oldest first. */
export const ThreadMessagesQuerySchema = z.object({
  before: IsoTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ThreadMessagesQuery = z.infer<typeof ThreadMessagesQuerySchema>;

export const ThreadMessagesResponseSchema = z.object({
  threadId: z.uuid(),
  kind: z.enum(['card', 'chat', 'devops', 'intake']),
  messages: z.array(ThreadMessageDtoSchema),
  hasMore: z.boolean(),
});
export type ThreadMessagesResponse = z.infer<typeof ThreadMessagesResponseSchema>;
export const ThreadParamsSchema = z.object({ id: z.uuid() });
