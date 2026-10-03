import { z } from 'zod';

export const Seniority = z.enum(['junior', 'senior']);
export type Seniority = z.infer<typeof Seniority>;

export const AgentPermissionsSchema = z.object({
  /** Provider neutral: 'read', 'edit', 'shell', 'web', 'mcp:<name>'. */
  allowedTools: z.array(z.string()),
  /** e.g. 'git push*', 'git rebase*', 'git checkout*', 'rm -rf /*'. */
  deniedShellPatterns: z.array(z.string()),
  /** null = whole worktree; tester: project.e2e_globs (resolved by the runner). */
  writableGlobs: z.array(z.string()).nullable(),
  mayCommit: z.boolean(),
  riskTiers: z.array(z.enum(['small', 'large'])).default(['small', 'large']),
  /** null = all project repos. */
  repoIds: z.array(z.uuid()).nullable(),
});
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;

export const RoleDefinitionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  version: z.number().int().min(1),
  name: z.string(),
  purpose: z.string(),
  department: z.string().optional(),
  builtIn: z.boolean(),
  /** Markdown, provider neutral. */
  instructions: z.string(),
  /** Immutable for built-ins (test ownership, review gates). */
  coreRules: z.array(z.string()),
  seniorityLevels: z.array(Seniority).min(1),
  defaultModel: z.object({ runtime: z.string(), model: z.string(), effort: z.string().optional() }),
  /** Default permissions for hires. */
  permissions: AgentPermissionsSchema,
  skills: z.array(z.string()),
  /** `workflowKey` or `*`, `stageId` or `*`. */
  claimableStages: z.array(z.object({ workflowKey: z.string(), stageId: z.string() })),
});
export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

export const RoleExtensionsSchema = z.object({
  instructions: z.string().default(''),
  skills: z.array(z.string()).default([]),
  standingOrders: z.array(z.string()).default([]),
});
export type RoleExtensions = z.infer<typeof RoleExtensionsSchema>;

/** True when `role` may claim `(workflowKey, stageId)`. */
export function roleClaimsStage(
  role: Pick<RoleDefinition, 'claimableStages'>,
  workflowKey: string,
  stageId: string,
): boolean {
  return role.claimableStages.some(
    (c) =>
      (c.workflowKey === workflowKey || c.workflowKey === '*') &&
      (c.stageId === stageId || c.stageId === '*'),
  );
}
