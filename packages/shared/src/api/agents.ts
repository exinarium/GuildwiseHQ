import { z } from 'zod';
import { AgentChangesSchema } from '../events/agent.ts';
import { AgentPermissionsSchema, Seniority } from '../roles/schema.ts';
import { IsoTime } from './common.ts';

export const AgentDtoSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  projectId: z.uuid().nullable(),
  hiredByUserId: z.uuid(),
  managerUserId: z.uuid(),
  workstationId: z.uuid().nullable(),
  name: z.string(),
  roleKey: z.string(),
  roleVersion: z.number().int(),
  seniority: Seniority,
  runtime: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  skills: z.array(z.string()),
  permissions: AgentPermissionsSchema,
  capacity: z.number().int(),
  isDevops: z.boolean(),
  status: z.enum(['active', 'retired', 'needs_rehome']),
  hiredAt: IsoTime,
  retiredAt: IsoTime.nullable(),
  /** M10: the department of the agent's role. */
  department: z.string().nullable().optional(),
  lastShiftEndedAt: IsoTime.nullable(),
  /** Active claims right now. */
  activeCards: z.array(z.object({ cardId: z.uuid(), ref: z.string(), title: z.string() })).default([]),
});
export type AgentDto = z.infer<typeof AgentDtoSchema>;
export const AgentsResponseSchema = z.object({ agents: z.array(AgentDtoSchema) });
export const AgentsQuerySchema = z.object({
  projectId: z.uuid().optional(),
  department: z.string().optional(),
});

/** `POST /api/agents` (hire). */
export const HireAgentRequestSchema = z.object({
  name: z.string().min(1).max(60),
  roleKey: z.string().min(1),
  seniority: Seniority,
  workstationId: z.uuid(),
  projectId: z.uuid().optional(),
  runtime: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().optional(),
  skills: z.array(z.string()).optional(),
  capacity: z.number().int().min(1).max(8).default(1),
});
export type HireAgentRequest = z.infer<typeof HireAgentRequestSchema>;

export const PatchAgentRequestSchema = AgentChangesSchema;
export type PatchAgentRequest = z.infer<typeof PatchAgentRequestSchema>;

/** `POST /api/agents/:id/rehome` (M3). */
export const RehomeAgentRequestSchema = z.object({
  workstationId: z.uuid(),
  runtime: z.string(),
  model: z.string(),
});
export type RehomeAgentRequest = z.infer<typeof RehomeAgentRequestSchema>;

export const NameSuggestionsQuerySchema = z.object({
  theme: z.string().optional(),
  count: z.coerce.number().int().min(1).max(20).default(5),
});
export const NameSuggestionsResponseSchema = z.object({ names: z.array(z.string()) });
