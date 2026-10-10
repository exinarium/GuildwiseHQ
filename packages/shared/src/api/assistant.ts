import { z } from 'zod';

/** Caps of the public assistant (also enforced on the server): turns per conversation and characters per message. */
export const ASSISTANT_LIMITS = { maxUserTurns: 12, userChars: 1000, assistantChars: 4000 } as const;

export const AssistantMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(ASSISTANT_LIMITS.assistantChars),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

/** `POST /api/public/assistant/chat`: the whole conversation so far (the server keeps none), ending with a user turn. */
export const AssistantChatRequestSchema = z.object({
  messages: z
    .array(AssistantMessageSchema)
    .min(1)
    .max(ASSISTANT_LIMITS.maxUserTurns * 2 - 1),
  /** The solution to a challenge from `GET /api/public/assistant/challenge`, needed after a few messages. */
  pow: z.object({ challenge: z.string().max(200), nonce: z.string().max(40) }).optional(),
});
export type AssistantChatRequest = z.infer<typeof AssistantChatRequestSchema>;

/** `GET /api/public/assistant/status`: whether to show the widget. `busy`: today's budget is used up. */
export const AssistantStatusSchema = z.object({
  available: z.boolean(),
  reason: z.enum(['busy']).optional(),
});
export type AssistantStatus = z.infer<typeof AssistantStatusSchema>;

export const AssistantChallengeSchema = z.object({ challenge: z.string(), bits: z.number().int() });
export type AssistantChallenge = z.infer<typeof AssistantChallengeSchema>;

/** One server-sent event of the chat stream. */
export const AssistantEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), code: z.string() }),
]);
export type AssistantEvent = z.infer<typeof AssistantEventSchema>;

/** `GET/PUT /api/platform/assistant` (super admin): the on/off switch and today's numbers. No conversations exist. */
export const PlatformAssistantSchema = z.object({
  /** The super admin's switch. */
  enabled: z.boolean(),
  /** The environment: `off` (no key, or AOM_ASSISTANT=off) or `public`. */
  mode: z.enum(['off', 'public']),
  keyConfigured: z.boolean(),
  model: z.string(),
  dailyCapUsd: z.number(),
  spentTodayUsd: z.number(),
  messagesToday: z.number().int(),
  /** The assistant answers visitors right now. */
  live: z.boolean(),
});
export type PlatformAssistant = z.infer<typeof PlatformAssistantSchema>;
export const UpdatePlatformAssistantRequestSchema = z.object({ enabled: z.boolean() });
export type UpdatePlatformAssistantRequest = z.infer<typeof UpdatePlatformAssistantRequestSchema>;
