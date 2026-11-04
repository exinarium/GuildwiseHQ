import { z } from 'zod';
import { PackAgentBriefSchema } from '../capabilities/pack-team.ts';
import { AgentPermissionsSchema, Seniority } from '../roles/schema.ts';

/**
 * Who runs an agent call on the runner. Kept apart from protocol/runner.ts so that release DTOs can carry it without
 * importing the whole runner protocol (which imports the release DTOs back).
 */
export const AgentRuntimeSpecSchema = z.object({
  agentId: z.uuid(),
  name: z.string(),
  roleKey: z.string(),
  seniority: Seniority,
  runtime: z.string(),
  model: z.string(),
  effort: z.string().optional(),
  skills: z.array(z.string()),
  permissions: AgentPermissionsSchema,
  isDevops: z.boolean(),
  /** Additive: the agent is set to ask before it runs pack scripts (gate `pack_scripts`); the runner then asks per script file. */
  packScriptsGated: z.boolean().optional(),
  /** Additive: the agent works as an agent of a pack (hired onto a seat); its instructions carry a fenced block saying so. */
  packAgent: PackAgentBriefSchema.optional(),
});
export type AgentRuntimeSpec = z.infer<typeof AgentRuntimeSpecSchema>;
