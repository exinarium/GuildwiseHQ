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
  /** The newest message, for the list preview (`body` is plain text, markdown stripped, at most `CHAT_PREVIEW_MAX` characters). */
  lastMessage: z
    .object({
      authorKind: z.enum(['user', 'agent', 'system']),
      body: z.string(),
      at: IsoTime,
    })
    .nullable()
    .optional(),
  /** Agent messages the viewer has not read yet (capped at `CHAT_UNREAD_MAX`); absent or 0 when none. */
  unreadCount: z.number().int().nonnegative().max(99).optional(),
  /** Closed by the viewer: hidden from the default list, shown under Archived. */
  archived: z.boolean().optional(),
  /** The viewer created it, so may delete it (unless it is linked to a card). */
  mine: z.boolean().optional(),
});
export type ChatDto = z.infer<typeof ChatDtoSchema>;

export const CreateChatResponseSchema = z.object({ chat: ChatDtoSchema });
export const ChatsResponseSchema = z.object({ chats: z.array(ChatDtoSchema) });
export const ChatParamsSchema = z.object({ id: z.uuid() });

/** `POST /api/chats/archive-all`: closes every open chat of the caller (never their live CEO standing chat). */
export const ArchiveAllChatsRequestSchema = z.object({
  exceptThreadIds: z.array(z.uuid()).max(500).optional(),
});
export type ArchiveAllChatsRequest = z.infer<typeof ArchiveAllChatsRequestSchema>;
export const ArchiveAllChatsResponseSchema = z.object({ archived: z.number().int().nonnegative() });
export type ArchiveAllChatsResponse = z.infer<typeof ArchiveAllChatsResponseSchema>;

/** `POST /api/chats/:id/read`: marks the chat read up to `upTo` (default: its newest message). Never moves back. */
export const MarkChatReadRequestSchema = z.object({ upTo: IsoTime.optional() });
export type MarkChatReadRequest = z.infer<typeof MarkChatReadRequestSchema>;

/** The unread count stops here (the badge shows "99+" beyond it). */
export const CHAT_UNREAD_MAX = 99;

/** Longest list preview, in characters. */
export const CHAT_PREVIEW_MAX = 140;

/** A message body as one plain line for list previews: markdown markers removed (without leaving gaps), cut to `max`. */
export function chatPreviewText(body: string, max = CHAT_PREVIEW_MAX): string {
  const plain = body
    .replace(/```[\s\S]*?(```|$)/g, ' code ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>+\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/(^|[\s(])[*_]+(?=\S)/g, '$1')
    .replace(/(?<=\S)[*_]+(?=$|[\s).,:;!?])/g, '')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
