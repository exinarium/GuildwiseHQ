import { z } from 'zod';
import { ReworkReason } from '../cards/types.ts';
import { RecommendationKind } from '../events/hr.ts';
import { RoleExtensionsSchema } from '../roles/schema.ts';
import { AgentDtoSchema } from './agents.ts';
import { IsoTime } from './common.ts';

/** A rate or count of one agent next to the average of the agents in its role. `null`: not enough data. */
export const StatValueSchema = z.object({
  value: z.number().nullable(),
  /** Average over the active agents of the same role; null when nobody has data. */
  team: z.number().nullable(),
});
export type StatValue = z.infer<typeof StatValueSchema>;

export const AgentStatsSchema = z.object({
  agentId: z.uuid(),
  windowDays: z.number().int(),
  from: IsoTime,
  to: IsoTime,
  /** Cards the agent touched in the window (denominator of the blocked rate). */
  cardsTouched: z.number().int(),
  cardsDone: StatValueSchema,
  blockedRate: StatValueSchema,
  reworkRate: StatValueSchema,
  /** Share of its cards that later failed test. */
  bugsEscaped: StatValueSchema,
  /** Share of the time since the window start (or hiring) that the agent spent on shift. */
  utilisation: StatValueSchema,
  tokensPerCard: StatValueSchema,
  /** Cards done per day over the last 14 days, oldest first (sparkline). */
  doneByDay: z.array(z.number().int()),
});
export type AgentStats = z.infer<typeof AgentStatsSchema>;

export const WorkQualitySchema = z.object({
  /** Rolling average of the reviewer score (1 to 5) on this agent's cards. */
  reviewScoreAvg: z.number().nullable(),
  reviewCount: z.number().int(),
  reworkByReason: z.array(
    z.object({ reason: ReworkReason, count: z.number().int(), countsAgainstBuilder: z.boolean() }),
  ),
  reworkRoundsPerCard: z.object({
    avg: z.number().nullable(),
    max: z.number().int(),
    cardsWithThreeOrMore: z.number().int(),
  }),
  bugsEscaped: z.number().int(),
  criteriaMissed: z.number().int(),
  testCoverage: z.object({
    cardsWithTests: z.number().int(),
    cardsMeasured: z.number().int(),
    rate: z.number().nullable(),
  }),
});
export type WorkQuality = z.infer<typeof WorkQualitySchema>;

export const HrAgentSchema = z.object({
  agent: AgentDtoSchema,
  hiredByName: z.string(),
  /** Cards this agent left Blocked on a question for the manager (the agent's status is "blocked" while it has any). */
  blockedOn: z.array(z.object({ cardId: z.uuid(), ref: z.string(), title: z.string() })).default([]),
  stats: AgentStatsSchema,
  quality: WorkQualitySchema,
});
export type HrAgent = z.infer<typeof HrAgentSchema>;

export const RecommendationActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('change_model'), agentId: z.uuid(), model: z.string(), fromModel: z.string() }),
  z.object({ type: z.literal('standing_order'), text: z.string(), topic: z.string().optional() }),
  z.object({
    type: z.literal('split_role'),
    agentId: z.uuid(),
    roleKey: z.string(),
    seniorModel: z.string(),
    juniorModel: z.string(),
    juniorName: z.string(),
  }),
  z.object({ type: z.literal('fire'), agentId: z.uuid() }),
  /** Advice without a one-click change (for example a strict reviewer). */
  z.object({ type: z.literal('none') }),
]);
export type RecommendationAction = z.infer<typeof RecommendationActionSchema>;

export const RecommendationSchema = z.object({
  /** Stable: `kind:subject`. */
  id: z.string(),
  kind: RecommendationKind,
  title: z.string(),
  summary: z.string(),
  agentId: z.uuid().nullable(),
  agentName: z.string().nullable(),
  roleKey: z.string().nullable(),
  /** The numbers and the examples that triggered the rule. */
  evidence: z.object({
    metrics: z.array(z.object({ label: z.string(), value: z.string() })),
    items: z.array(z.object({ text: z.string(), ref: z.string().optional() })),
  }),
  action: RecommendationActionSchema,
  /** Whether the requesting user may apply it (owner, or the hiring manager for their own agent). */
  canApply: z.boolean(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const RoleUpdateSchema = z.object({
  roleKey: z.string(),
  roleName: z.string(),
  /** Version the owner's extensions were written against. */
  /** Version the owner's extensions were written for; null when the role has no extensions. */
  extensionBaseVersion: z.number().int().nullable(),
  latestVersion: z.number().int(),
  purpose: z.string(),
  /** What a reset removes. */
  extensions: RoleExtensionsSchema,
  /** Agents still pinned to an older version of the role. */
  agentsOnOlderVersion: z.number().int(),
});
export type RoleUpdate = z.infer<typeof RoleUpdateSchema>;

/** `GET /api/hr/board?projectId=` */
export const HrBoardQuerySchema = z.object({
  projectId: z.uuid().optional(),
  department: z.string().optional(),
});
export const HrBoardResponseSchema = z.object({
  windowDays: z.number().int(),
  agents: z.array(HrAgentSchema),
  recommendations: z.array(RecommendationSchema),
  /** Built-in roles of the viewer's own organization whose default moved on (the owner resets them). */
  roleUpdates: z.array(RoleUpdateSchema),
});
export type HrBoardResponse = z.infer<typeof HrBoardResponseSchema>;

export const AgentStatsResponseSchema = z.object({ stats: AgentStatsSchema, quality: WorkQualitySchema });
export const RecommendationsResponseSchema = z.object({ recommendations: z.array(RecommendationSchema) });
export const RoleUpdatesResponseSchema = z.object({ roleUpdates: z.array(RoleUpdateSchema) });

export const RecommendationIdParamsSchema = z.object({ id: z.string().min(1) });
export const ApplyRecommendationResponseSchema = z.object({
  applied: z.literal(true),
  effect: z.string(),
  /** Standing-order proposals land on the desk as an approval. */
  deskItemId: z.uuid().nullable(),
  agentIds: z.array(z.uuid()),
});
export type ApplyRecommendationResponse = z.infer<typeof ApplyRecommendationResponseSchema>;

export const RoleKeyParamsSchema = z.object({ key: z.string().min(1) });
export const ResetRoleResponseSchema = z.object({
  roleKey: z.string(),
  toVersion: z.number().int(),
  droppedExtensions: RoleExtensionsSchema,
  updatedAgentIds: z.array(z.uuid()),
});
export type ResetRoleResponse = z.infer<typeof ResetRoleResponseSchema>;
