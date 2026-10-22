import { z } from 'zod';
import {
  ParticipantDtoSchema,
  ParticipantInputSchema,
  SessionThreadKindSchema,
  SessionTurnDtoSchema,
} from '../sessions/index.ts';
import { ThreadMessageDtoSchema } from './cards.ts';

/** `POST /api/sessions`: creates a discovery or boardroom thread with its participants. */
export const CreateSessionRequestSchema = z.object({
  kind: SessionThreadKindSchema,
  title: z.string().min(1).max(200),
  projectId: z.uuid().optional(),
  /** The host agent (the analyst for a discovery session). Added as a participant with the seat "Facilitator" if not listed. */
  facilitatorAgentId: z.uuid().optional(),
  participants: z.array(ParticipantInputSchema).max(20).default([]),
  /** Where the turns run. Default: the facilitator's workstation, else the caller's most recently seen workstation of the organization. */
  workstationId: z.uuid().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const PatchSessionRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  /** Merged into the session config key by key; `null` removes a key. */
  config: z.record(z.string(), z.unknown()).optional(),
  workstationId: z.uuid().optional(),
});
export type PatchSessionRequest = z.infer<typeof PatchSessionRequestSchema>;

export const SessionDtoSchema = z.object({
  threadId: z.uuid(),
  kind: SessionThreadKindSchema,
  title: z.string(),
  projectId: z.uuid().nullable(),
  facilitatorAgentId: z.uuid().nullable(),
  workstationId: z.uuid().nullable(),
  workstationOnline: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime().nullable(),
  participants: z.array(ParticipantDtoSchema),
});
export type SessionDto = z.infer<typeof SessionDtoSchema>;

export const ListSessionsQuerySchema = z.object({
  kind: SessionThreadKindSchema.optional(),
  projectId: z.uuid().optional(),
});
export const SessionParamsSchema = z.object({ id: z.uuid() });
export const SessionParticipantParamsSchema = z.object({ id: z.uuid(), participantId: z.uuid() });

export const PatchParticipantRequestSchema = z.object({
  seat: z.string().min(1).max(60).optional(),
  stance: z.string().max(500).optional(),
});

/** `POST /api/sessions/:id/messages`: a message of a human participant. It queues no turn by itself. */
export const PostSessionMessageRequestSchema = z.object({
  body: z.string().min(1).max(20_000),
  kind: z.enum(['chat', 'comment', 'system']).default('chat'),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type PostSessionMessageRequest = z.infer<typeof PostSessionMessageRequestSchema>;

export const SessionMessageResponseSchema = z.object({ message: ThreadMessageDtoSchema });
export const SessionTurnResponseSchema = z.object({ turn: SessionTurnDtoSchema });
export const SessionTurnsResponseSchema = z.object({ turns: z.array(SessionTurnDtoSchema) });
export const SessionTurnParamsSchema = z.object({ id: z.uuid(), turnId: z.uuid() });
