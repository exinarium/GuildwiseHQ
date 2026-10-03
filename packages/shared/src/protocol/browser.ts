import { z } from 'zod';
import { VisibleEventSchema } from '../events/envelope.ts';
import { ProgressItemSchema } from './runner.ts';

/**
 * Browser WebSocket (`/api/ws`, docs/ARCHITECTURE.md section 20). Authenticated by the session cookie at upgrade
 * (+ Origin check). Messages are `{ type, ...fields }`.
 */

export const RESYNC_THRESHOLD = 500;

// client -> server
export const BrowserHelloSchema = z.object({
  type: z.literal('hello'),
  lastSeq: z.number().int().nonnegative().optional(),
});
export const BrowserChatSendSchema = z.object({
  type: z.literal('chat.send'),
  threadId: z.uuid(),
  body: z.string().min(1),
  clientMsgId: z.string().min(1),
});
export const BrowserChatCancelSchema = z.object({ type: z.literal('chat.cancel'), threadId: z.uuid() });
export const BrowserShiftWatchSchema = z.object({ type: z.literal('shift.watch'), shiftId: z.uuid() });
export const BrowserShiftUnwatchSchema = z.object({ type: z.literal('shift.unwatch'), shiftId: z.uuid() });
export const BrowserPingSchema = z.object({ type: z.literal('ping') });

export const BrowserToServerSchema = z.discriminatedUnion('type', [
  BrowserHelloSchema,
  BrowserChatSendSchema,
  BrowserChatCancelSchema,
  BrowserShiftWatchSchema,
  BrowserShiftUnwatchSchema,
  BrowserPingSchema,
]);
export type BrowserToServer = z.infer<typeof BrowserToServerSchema>;

// server -> client
export const ReadySchema = z.object({ type: z.literal('ready'), seq: z.number().int().nonnegative() });
export const EventMsgSchema = z.object({ type: z.literal('event'), event: VisibleEventSchema });
/** Sent if `lastSeq` is more than RESYNC_THRESHOLD visible events behind; the client invalidates all queries. */
export const ResyncSchema = z.object({ type: z.literal('resync') });
export const BrowserShiftProgressSchema = z.object({
  type: z.literal('shift.progress'),
  shiftId: z.uuid(),
  cardId: z.uuid().nullable(),
  items: z.array(ProgressItemSchema),
});
export const BrowserChatDeltaSchema = z.object({
  type: z.literal('chat.delta'),
  threadId: z.uuid(),
  text: z.string(),
});
export const BrowserChatDoneSchema = z.object({
  type: z.literal('chat.done'),
  threadId: z.uuid(),
  messageId: z.uuid(),
});
export const BrowserChatErrorSchema = z.object({
  type: z.literal('chat.error'),
  threadId: z.uuid(),
  reason: z.string(),
});
export const PresenceSchema = z.object({
  type: z.literal('presence'),
  workstationId: z.uuid(),
  connected: z.boolean(),
});
export const PongSchema = z.object({ type: z.literal('pong') });

export const ServerToBrowserSchema = z.discriminatedUnion('type', [
  ReadySchema,
  EventMsgSchema,
  ResyncSchema,
  BrowserShiftProgressSchema,
  BrowserChatDeltaSchema,
  BrowserChatDoneSchema,
  BrowserChatErrorSchema,
  PresenceSchema,
  PongSchema,
]);
export type ServerToBrowser = z.infer<typeof ServerToBrowserSchema>;
