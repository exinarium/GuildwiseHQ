import { z } from 'zod';
import { AvatarStyleSchema } from '../avatars/index.ts';
import { Seniority } from '../roles/schema.ts';
import { IsoTime } from './common.ts';
import { SpendBriefSchema } from './costs.ts';

/** What an agent is doing right now, as the chart shows it (a ring and a label, never colour alone). */
export const OrgChartStatusSchema = z.enum(['working', 'blocked', 'idle', 'offline', 'needs_rehome']);
export type OrgChartStatus = z.infer<typeof OrgChartStatusSchema>;

/** Who answers an agent's question first: a senior of its role, then the BA, then the CEO (when there is one), then the manager's desk. */
export const EscalationLevelSchema = z.enum(['peer', 'ba', 'ceo', 'desk']);
export type EscalationLevel = z.infer<typeof EscalationLevelSchema>;

export const OrgChartAgentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  roleKey: z.string(),
  roleLabel: z.string(),
  /** The role's department key (`delivery`, `research`, a custom one), or null. */
  department: z.string().nullable(),
  seniority: Seniority,
  isDevops: z.boolean(),
  status: OrgChartStatusSchema,
  avatarSeed: z.string(),
  avatarStyle: AvatarStyleSchema,
  runtime: z.string(),
  model: z.string(),
  capacity: z.number().int(),
  hiredAt: IsoTime,
  workstation: z.object({ id: z.uuid(), name: z.string(), online: z.boolean() }).nullable(),
  /** The hiring manager: the agent's reporting line (it reports to them, and through them to the Owner). */
  reportsTo: z.object({
    userId: z.uuid(),
    name: z.string(),
    orgRole: z.enum(['owner', 'admin', 'member']).nullable(),
  }),
  /** Where this agent's questions go first. `agentIds` are the agents at that level (empty for the desk). */
  escalatesTo: z.object({ level: EscalationLevelSchema, agentIds: z.array(z.uuid()) }),
  /** Projects it may work on; null: any project of the organization. */
  allowedProjectIds: z.array(z.uuid()).nullable(),
  focusProjectIds: z.array(z.uuid()),
  activeCards: z.array(z.object({ cardId: z.uuid(), ref: z.string(), title: z.string() })),
  blockedCards: z.array(z.object({ cardId: z.uuid(), ref: z.string(), title: z.string() })),
  recentWork: z.array(
    z.object({
      shiftId: z.uuid(),
      kind: z.string(),
      outcome: z.string().nullable(),
      endedAt: IsoTime.nullable(),
      cardId: z.uuid().nullable(),
      ref: z.string().nullable(),
      title: z.string().nullable(),
    }),
  ),
  spend: SpendBriefSchema,
});
export type OrgChartAgent = z.infer<typeof OrgChartAgentSchema>;

export const OrgChartSchema = z.object({
  /** The organization's Owner: the top of every reporting line. */
  owner: z.object({ userId: z.uuid(), name: z.string() }),
  admins: z.array(z.object({ userId: z.uuid(), name: z.string() })),
  /** Departments in display order (key, label) that have at least one agent. */
  departments: z.array(z.object({ key: z.string(), label: z.string() })),
  agents: z.array(OrgChartAgentSchema),
  /** The CEO between the Owner and the rest (absent: none). */
  ceo: z.object({ agentId: z.uuid(), paused: z.boolean() }).nullable().optional(),
  /** The projects of the organization (for the allow-list filter). */
  projects: z.array(z.object({ id: z.uuid(), key: z.string(), name: z.string() })),
  /** Each workstation that hosts agents, with its DevOps engineer (shown apart from the chart). */
  workstations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      online: z.boolean(),
      ownerName: z.string(),
      devopsAgentId: z.uuid().nullable(),
      agentIds: z.array(z.uuid()),
    }),
  ),
});
export type OrgChart = z.infer<typeof OrgChartSchema>;
