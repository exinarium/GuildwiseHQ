import { z } from 'zod';
import { AgentPermissionsSchema, Seniority } from '../roles/schema.ts';
import { defineEvent, Id } from './define.ts';

export const AgentChangesSchema = z
  .object({
    model: z.string(),
    effort: z.string().nullable(),
    runtime: z.string(),
    roleKey: z.string(),
    roleVersion: z.number().int().min(1),
    seniority: Seniority,
    skills: z.array(z.string()),
    permissions: AgentPermissionsSchema,
    capacity: z.number().int().min(1).max(8),
  })
  .partial();
export type AgentChanges = z.infer<typeof AgentChangesSchema>;

/** Who accepted, and when, that the agent runs on a runtime with no OS sandbox. */
export const UnsandboxedAckSchema = z.object({ by: Id, at: z.iso.datetime() });
export type UnsandboxedAck = z.infer<typeof UnsandboxedAckSchema>;

export const agentEvents = [
  defineEvent(
    'AgentHired',
    z.object({
      agentId: Id,
      orgId: Id,
      projectId: Id.optional(),
      hiredByUserId: Id,
      workstationId: Id,
      name: z.string().min(1),
      roleKey: z.string().min(1),
      roleVersion: z.number().int().min(1),
      seniority: Seniority,
      runtime: z.string().min(1),
      model: z.string().min(1),
      effort: z.string().optional(),
      skills: z.array(z.string()),
      permissions: AgentPermissionsSchema,
      capacity: z.number().int().min(1).max(8),
      isDevops: z.boolean(),
      unsandboxedAck: UnsandboxedAckSchema.optional(),
    }),
  ),
  defineEvent(
    'AgentChanged',
    z.object({ agentId: Id, changes: AgentChangesSchema, unsandboxedAck: UnsandboxedAckSchema.optional() }),
  ),
  defineEvent('AgentRetired', z.object({ agentId: Id, by: Id, releasedCardIds: z.array(Id) })),
  defineEvent('AgentReset', z.object({ agentId: Id })),
  defineEvent(
    'AgentRehomed',
    z.object({
      agentId: Id,
      workstationId: Id,
      runtime: z.string(),
      model: z.string(),
      unsandboxedAck: UnsandboxedAckSchema.optional(),
    }),
  ),
] as const;
