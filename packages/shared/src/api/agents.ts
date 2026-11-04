import { z } from 'zod';
import { AvatarStyleSchema } from '../avatars/index.ts';
import { PackPersonaRefSchema } from '../capabilities/pack-team.ts';
import { PackProvenanceSchema } from '../capabilities/provenance.ts';
import { AgentChangesSchema } from '../events/agent.ts';
import { RuntimeInfoSchema, SandboxStateSchema } from '../protocol/runner.ts';
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
  /** The agent's workstation by name and state, so a stuck agent shows where it is (absent: not reported). */
  workstationName: z.string().nullable().optional(),
  workstationState: z.enum(['connected', 'offline', 'unpaired']).nullable().optional(),
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
  /**
   * R3a: hired from a pack persona (`ACME · analyst · v1.2.0`). `warning`: the pack's approval was withdrawn (`revoked`) or the
   * pack was removed; the agent keeps its role version and its work, and shows a warning.
   */
  /**
   * Hired from a pack onto a seat: the pack agent it works as. `provenance` is filled too (the same tag and warning), so the
   * HR board shows "hired from <pack>" with no extra code; `packAgent` adds what is specific to a seat.
   */
  packAgent: PackPersonaRefSchema.nullable().optional(),
  /** Active agent whose workstation was unpaired or removed: it needs a new workstation. */
  workstationRemoved: z.boolean().optional(),
  provenance: PackProvenanceSchema.extend({
    label: z.string(),
    warning: z.enum(['revoked', 'removed', 'missing']).nullable().default(null),
  })
    .nullable()
    .optional(),
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

/** A workstation an agent can be moved to (`GET /api/agents/:id/move-targets`). */
export const MoveTargetDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  ownerUserId: z.uuid(),
  ownerName: z.string(),
  /** The workstation belongs to the caller. */
  mine: z.boolean(),
  connected: z.boolean(),
  runtimes: z.array(RuntimeInfoSchema),
});
export type MoveTargetDto = z.infer<typeof MoveTargetDtoSchema>;
export const MoveTargetsResponseSchema = z.object({
  current: z
    .object({ id: z.uuid(), name: z.string(), state: z.enum(['connected', 'offline', 'unpaired']) })
    .nullable(),
  workstations: z.array(MoveTargetDtoSchema),
});
export type MoveTargetsResponse = z.infer<typeof MoveTargetsResponseSchema>;

/** `POST /api/workstations/:id/move-agents` (and `GET .../move-agents/preview?targetWorkstationId=`). */
export const MoveAllAgentsRequestSchema = z.object({
  targetWorkstationId: z.uuid(),
  /** Required when the target runs an agent's runtime without an OS sandbox (same rule as the single move). */
  acknowledgeUnsandboxed: z.boolean().optional(),
});
export type MoveAllAgentsRequest = z.infer<typeof MoveAllAgentsRequestSchema>;
export const MoveAllAgentsPreviewQuerySchema = z.object({
  targetWorkstationId: z.uuid(),
  acknowledgeUnsandboxed: z.stringbool().optional(),
});

export const MoveSkipReasonSchema = z.enum(['running_shift', 'workstation_devops', 'ceo']);
export type MoveSkipReason = z.infer<typeof MoveSkipReasonSchema>;
const MovedAgentSchema = z.object({ agentId: z.uuid(), name: z.string() });
export const MoveAllAgentsResponseSchema = z.object({
  dryRun: z.boolean(),
  source: z.object({ id: z.uuid(), name: z.string(), status: z.enum(['active', 'unlinked']) }),
  target: z.object({ id: z.uuid(), name: z.string() }),
  /** Moved (dryRun: would move). */
  moved: z.array(MovedAgentSchema),
  /** `message`: the single move's text for a running shift or claimed card; absent for the built-in skips. */
  skipped: z.array(MovedAgentSchema.extend({ reason: MoveSkipReasonSchema, message: z.string().optional() })),
  /** Refused by the single move (code from the error, e.g. runtime_missing, sandbox_unavailable, limit_reached). */
  failed: z.array(MovedAgentSchema.extend({ code: z.string(), error: z.string() })),
  /** True when at least one agent would run unsandboxed on the target and no acknowledgement was sent. */
  needsUnsandboxedAck: z.boolean(),
});
export type MoveAllAgentsResponse = z.infer<typeof MoveAllAgentsResponseSchema>;

/** `GET /api/agents/workstations`: workstations (any status) holding this organization's agents (owner/admin). */
export const AgentHomeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(['active', 'unlinked']),
  connected: z.boolean(),
  ownerName: z.string(),
  mine: z.boolean(),
  /** Non-retired agents of the organization on it, the built-in DevOps engineer and CEO excluded. */
  agentCount: z.number().int(),
  runningCount: z.number().int(),
});
export type AgentHome = z.infer<typeof AgentHomeSchema>;
export const AgentHomesResponseSchema = z.object({ workstations: z.array(AgentHomeSchema) });
export type AgentHomesResponse = z.infer<typeof AgentHomesResponseSchema>;

export const NameSuggestionsQuerySchema = z.object({
  theme: z.string().optional(),
  count: z.coerce.number().int().min(1).max(20).default(5),
});
export const NameSuggestionsResponseSchema = z.object({ names: z.array(z.string()) });
