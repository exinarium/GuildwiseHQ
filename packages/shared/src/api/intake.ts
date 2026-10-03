import { z } from 'zod';
import { ExternalSystem } from '../events/intake.ts';
import { IsoTime } from './common.ts';

/** `POST /api/intakes`: opens the BA intake chat for a ticket (a key or URL) or a free-text need. */
export const CreateIntakeRequestSchema = z.object({
  externalSystem: ExternalSystem.optional(),
  externalKey: z.string().min(1).max(200).optional(),
  /** What the manager typed: a Jira key, a GitHub issue reference or URL, or a description of the need. */
  note: z.string().min(1).max(20000),
});
export type CreateIntakeRequest = z.infer<typeof CreateIntakeRequestSchema>;

export const IntakeCardDtoSchema = z.object({
  id: z.uuid(),
  ref: z.string(),
  title: z.string(),
  stage: z.string(),
  status: z.string(),
  projectKey: z.string(),
});
export type IntakeCardDto = z.infer<typeof IntakeCardDtoSchema>;

export const IntakeDtoSchema = z.object({
  id: z.uuid(),
  /** The intake chat thread (messages via `GET /api/threads/:id/messages`, live over the chat socket). */
  threadId: z.uuid(),
  externalSystem: ExternalSystem.nullable(),
  externalKey: z.string().nullable(),
  status: z.enum(['open', 'mapped', 'unmapped']),
  mappedProjectId: z.uuid().nullable(),
  mappedProjectKey: z.string().nullable(),
  /** The desk question that asks the manager which project an unmapped ticket belongs to. */
  mappingDeskItemId: z.uuid().nullable(),
  baAgentId: z.uuid(),
  baAgentName: z.string(),
  workstationOnline: z.boolean(),
  cards: z.array(IntakeCardDtoSchema),
  createdAt: IsoTime,
});
export type IntakeDto = z.infer<typeof IntakeDtoSchema>;

export const IntakeParamsSchema = z.object({ id: z.uuid() });
export const CreateIntakeResponseSchema = z.object({ intake: IntakeDtoSchema });
export const IntakeResponseSchema = z.object({ intake: IntakeDtoSchema });
export const IntakesResponseSchema = z.object({ intakes: z.array(IntakeDtoSchema) });
