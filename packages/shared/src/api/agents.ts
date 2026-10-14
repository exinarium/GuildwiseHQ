import { z } from 'zod';
import { AvatarStyleSchema } from '../avatars/index.ts';
import { AgentChangesSchema } from '../events/agent.ts';
import { SandboxStateSchema } from '../protocol/runner.ts';
import { AgentPermissionsSchema, Seniority } from '../roles/schema.ts';
import { IsoTime } from './common.ts';

export const AgentDtoSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  /** The project the agent was hired for: history only, it does not limit where the agent works. */
  hiredForProjectId: z.uuid().nullable(),
  /** Projects the agent may work on; null means any project of the organization. */
  allowedProjectIds: z.array(z.uuid()).nullable(),
  /** Projects the agent prefers (a soft preference inside the allow-list). */
  focusProjectIds: z.array(z.uuid()).default([]),
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
  /** The generated face (seed and style); every agent has one. */
  avatarSeed: z.string().optional(),
  avatarStyle: AvatarStyleSchema.optional(),
  /** The agent takes no new work (paused by a manager or by the CEO); null when it works. */
  pausedAt: IsoTime.nullable().optional(),
  pauseReason: z.string().nullable().optional(),
  pausedByCeo: z.boolean().optional(),
  /** The OS-sandbox state its workstation reports for the agent's runtime (null/absent: not reported). */
  sandbox: SandboxStateSchema.nullable().optional(),
  sandboxReason: z.string().nullable().optional(),
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
  /**
   * Alias kept for older clients: the agent is hired for this project and allowed on it only (unless
   * `allowedProjectIds` says otherwise).
   */
  projectId: z.uuid().optional(),
  /**
   * Where the agent may work: a list of projects, or null for any project of the organization (Owner and Admins
   * only). Omitted: any project, or `[projectId]` when the alias is given.
   */
  allowedProjectIds: z.array(z.uuid()).max(500).nullable().optional(),
  /** Projects to prefer, inside the allow-list. */
  focusProjectIds: z.array(z.uuid()).max(10).optional(),
  runtime: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().optional(),
  skills: z.array(z.string()).optional(),
  capacity: z.number().int().min(1).max(8).default(1),
  /** Required to hire onto a runtime that reports `unsandboxed` (409 `unsandboxed_ack_required` without it). */
  acknowledgeUnsandboxed: z.boolean().optional(),
});
export type HireAgentRequest = z.infer<typeof HireAgentRequestSchema>;

export const PatchAgentRequestSchema = AgentChangesSchema.extend({
  acknowledgeUnsandboxed: z.boolean().optional(),
});
export type PatchAgentRequest = z.infer<typeof PatchAgentRequestSchema>;

/** `PUT /api/agents/:id/allowed-projects`: a project list, or null for any project. */
export const SetAllowedProjectsRequestSchema = z.object({
  projectIds: z.array(z.uuid()).max(500).nullable(),
});
export type SetAllowedProjectsRequest = z.infer<typeof SetAllowedProjectsRequestSchema>;
/** `PUT /api/agents/:id/focus-projects`. */
export const SetFocusProjectsRequestSchema = z.object({ projectIds: z.array(z.uuid()).max(10) });
export type SetFocusProjectsRequest = z.infer<typeof SetFocusProjectsRequestSchema>;

/** `POST /api/agents/:id/rehome` (M3). */
export const RehomeAgentRequestSchema = z.object({
  workstationId: z.uuid(),
  runtime: z.string(),
  model: z.string(),
  acknowledgeUnsandboxed: z.boolean().optional(),
});
export type RehomeAgentRequest = z.infer<typeof RehomeAgentRequestSchema>;

export const NameSuggestionsQuerySchema = z.object({
  theme: z.string().optional(),
  count: z.coerce.number().int().min(1).max(20).default(5),
});
export const NameSuggestionsResponseSchema = z.object({ names: z.array(z.string()) });
