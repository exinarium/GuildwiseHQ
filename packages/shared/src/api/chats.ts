import { z } from 'zod';
import { IsoTime } from './common.ts';

/** `POST /api/chats`: starts a conversation with an agent the user may direct. */
export const CreateChatRequestSchema = z.object({
  agentId: z.uuid(),
  projectId: z.uuid().optional(),
  cardId: z.uuid().optional(),
});
export type CreateChatRequest = z.infer<typeof CreateChatRequestSchema>;

export const ChatDtoSchema = z.object({
  threadId: z.uuid(),
  title: z.string(),
  agentId: z.uuid(),
  agentName: z.string(),
  agentRole: z.string(),
  projectId: z.uuid().nullable(),
  cardId: z.uuid().nullable(),
  cardRef: z.string().nullable(),
  /** The agent's workstation is connected right now (chat only works while it is). */
  workstationOnline: z.boolean(),
  createdAt: IsoTime,
  lastMessageAt: IsoTime.nullable(),
  /** Closed by the viewer: hidden from the default list, shown under Archived. */
  archived: z.boolean().optional(),
  /** The viewer created it, so may delete it (unless it is linked to a card). */
  mine: z.boolean().optional(),
});
export type ChatDto = z.infer<typeof ChatDtoSchema>;

export const CreateChatResponseSchema = z.object({ chat: ChatDtoSchema });
export const ChatsResponseSchema = z.object({ chats: z.array(ChatDtoSchema) });
export const ChatParamsSchema = z.object({ id: z.uuid() });
