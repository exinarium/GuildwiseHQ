import { z } from 'zod';
import { ThreadMessageDtoSchema } from '../api/cards.ts';
import { VisibleEventSchema } from '../events/envelope.ts';
import { ModelChoiceSchema } from '../models/choices.ts';
import { ChatSegmentSchema, ProgressItemSchema } from './runner.ts';

/**
 * Browser WebSocket (`/api/ws`, docs/ARCHITECTURE.md section 20). Authenticated by the session cookie at upgrade
 * (+ Origin check). Messages are `{ type, ...fields }`.
 */

export const RESYNC_THRESHOLD = 500;

/** `chat.error.reason` values the server sends. */
export const CHAT_ERROR = {
  workstationOffline: 'workstation_offline',
  simulationWorkstation: 'simulation_workstation',
  unknownThread: 'unknown_thread',
  busy: 'busy',
  projectPaused: 'project_paused',
  cancelled: 'cancelled',
  runnerError: 'runner_error',
  /** The DevOps engineer works through the CEO now: its chats are read-only (docs/design/ceo-front-door.md section 8). */
  devopsViaCeo: 'devops_via_ceo',
  /** The standing "BA reports" chat is read-only: the BA no longer reports, the CEO does (docs/design/ceo-front-door.md step 3). */
  baReportsRetired: 'ba_reports_retired',
  unknownModel: 'unknown_model',
} as const;

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
  /** The CEO chat's model switch: this choice applies to this message, or (modelScope 'thread') to the whole conversation. */
  model: ModelChoiceSchema.optional(),
  modelScope: z.enum(['message', 'thread']).optional(),
});
export const BrowserChatCancelSchema = z.object({ type: z.literal('chat.cancel'), threadId: z.uuid() });
export const BrowserShiftWatchSchema = z.object({ type: z.literal('shift.watch'), shiftId: z.uuid() });
export const BrowserShiftUnwatchSchema = z.object({ type: z.literal('shift.unwatch'), shiftId: z.uuid() });
/** Follow the logs of a run environment (the runner sends log lines only while somebody follows). */
export const BrowserRunWatchSchema = z.object({ type: z.literal('run.watch'), envId: z.uuid() });
export const BrowserRunUnwatchSchema = z.object({ type: z.literal('run.unwatch'), envId: z.uuid() });
export const BrowserPingSchema = z.object({ type: z.literal('ping') });

export const BrowserToServerSchema = z.discriminatedUnion('type', [
  BrowserHelloSchema,
  BrowserChatSendSchema,
  BrowserChatCancelSchema,
  BrowserShiftWatchSchema,
  BrowserShiftUnwatchSchema,
  BrowserRunWatchSchema,
  BrowserRunUnwatchSchema,
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
  /** Additive: the stored agent message (what `GET /api/threads/:id/messages` returns), to swap the streamed bubble for. */
  message: ThreadMessageDtoSchema.optional(),
});
/** Tool activity of the running turn (forwarded from the runner, not stored): see `ChatActivitySchema`. */
export const BrowserChatActivitySchema = z.object({
  type: z.literal('chat.activity'),
  threadId: z.uuid(),
  seq: z.number().int().nonnegative(),
  segment: ChatSegmentSchema,
  replace: z.boolean().optional(),
});
/** The CEO's workstation is offline: the message is saved and waits (it is sent when the workstation is back). */
export const BrowserChatQueuedSchema = z.object({
  type: z.literal('chat.queued'),
  threadId: z.uuid(),
  clientMsgId: z.string().optional(),
  workstationName: z.string().optional(),
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
/** A run environment changed (state, services, expiry): the client refetches it. */
export const BrowserRunChangedSchema = z.object({ type: z.literal('run.changed'), envId: z.uuid() });
export const BrowserRunLogSchema = z.object({
  type: z.literal('run.log'),
  envId: z.uuid(),
  service: z.string(),
  lines: z.array(z.string()),
  history: z.boolean().optional(),
});
export const PongSchema = z.object({ type: z.literal('pong') });

export const ServerToBrowserSchema = z.discriminatedUnion('type', [
  ReadySchema,
  EventMsgSchema,
  ResyncSchema,
  BrowserShiftProgressSchema,
  BrowserChatDeltaSchema,
  BrowserChatActivitySchema,
  BrowserChatDoneSchema,
  BrowserChatQueuedSchema,
  BrowserChatErrorSchema,
  PresenceSchema,
  BrowserRunChangedSchema,
  BrowserRunLogSchema,
  PongSchema,
]);
export type ServerToBrowser = z.infer<typeof ServerToBrowserSchema>;
