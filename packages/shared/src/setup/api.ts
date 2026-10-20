import { z } from 'zod';
import { RunPlanSchema } from '../runs/plan.ts';
import { SetupAreaSchema, SetupProposalSchema } from './proposal.ts';

/**
 * API of the guided run steps and the scan (docs/design/deploy-run-ux-design.md sections 5 and 7.3):
 * `GET|PUT /api/projects/:id/run-plan`, `POST .../run-plan/test`, `POST .../scan`, `GET .../proposals`,
 * `POST /api/setup-proposals/:id/resolve`.
 */

/** Who wrote a saved run plan: the DevOps engineer (`aom run ready`, also the default for old rows), the owner, or a confirmed scan. */
export const RunPlanSourceSchema = z.enum(['devops', 'owner', 'scan']);
export type RunPlanSource = z.infer<typeof RunPlanSourceSchema>;

export const RunPlanVersionDtoSchema = z.object({
  id: z.uuid(),
  /** Null: the project-wide plan, used on every workstation without a plan of its own. */
  workstationId: z.uuid().nullable(),
  workstationName: z.string().nullable(),
  version: z.number().int(),
  status: z.enum(['active', 'stale', 'superseded']),
  source: RunPlanSourceSchema,
  plan: RunPlanSchema,
  savedAt: z.iso.datetime(),
  savedByName: z.string().nullable(),
  /** The last start from this plan that failed (an owner/scan plan stays active and is flagged instead of going stale). */
  lastFailure: z.object({ reason: z.string(), at: z.iso.datetime() }).nullable(),
});
export type RunPlanVersionDto = z.infer<typeof RunPlanVersionDtoSchema>;

export const ScanStatusSchema = z.enum(['queued', 'running', 'needs_approval', 'done', 'failed']);

export const ScanStateDtoSchema = z.object({
  requestId: z.uuid(),
  area: SetupAreaSchema,
  status: ScanStatusSchema,
  workstationId: z.uuid(),
  workstationName: z.string(),
  startedAt: z.iso.datetime(),
});
export type ScanStateDto = z.infer<typeof ScanStateDtoSchema>;

export const ProposalDtoSchema = z.object({
  id: z.uuid(),
  area: SetupAreaSchema,
  status: z.enum(['open', 'accepted', 'dismissed', 'superseded']),
  requestId: z.uuid(),
  workstationId: z.uuid(),
  workstationName: z.string(),
  proposal: SetupProposalSchema,
  submittedAt: z.iso.datetime(),
});
export type ProposalDto = z.infer<typeof ProposalDtoSchema>;

export const RunWorkstationDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  connected: z.boolean(),
  mine: z.boolean(),
  /** The runner can run a branch (`runs:1`) and replay a plan (`runs:2`): "Test these steps" works here. */
  canRun: z.boolean(),
  /** The runner can do a scan (`setup-scan:1`), has a DevOps engineer and a clone of the project's repositories. */
  canScan: z.boolean(),
  /** Why not, in a sentence ("Guildwise on Office PC is too old for scans"); null when it can. */
  scanBlocked: z.string().nullable(),
});
export type RunWorkstationDto = z.infer<typeof RunWorkstationDtoSchema>;

export const RunPlanOverviewSchema = z.object({
  canEdit: z.boolean(),
  repos: z.array(z.object({ repoId: z.uuid(), name: z.string() })),
  workstations: z.array(RunWorkstationDtoSchema),
  projectPlan: RunPlanVersionDtoSchema.nullable(),
  /** Plans of single workstations (DevOps repairs, overrides). */
  workstationPlans: z.array(RunPlanVersionDtoSchema),
  /** A scan that is queued or running, else null. */
  scan: ScanStateDtoSchema.nullable(),
  /** Why the last scan ended without a proposal (a failed DevOps request), when it did and nothing newer exists. */
  scanProblem: z.string().nullable(),
  /** The newest proposal that waits for a decision. */
  proposal: ProposalDtoSchema.nullable(),
  /** The newest start of the project (manual or test environment): "Last start: OK 2 h ago". */
  lastStart: z
    .object({
      state: z.enum(['ok', 'failed', 'running']),
      at: z.iso.datetime(),
      workstationName: z.string(),
      failure: z.string().nullable(),
    })
    .nullable(),
});
export type RunPlanOverview = z.infer<typeof RunPlanOverviewSchema>;

/** `PUT /api/projects/:id/run-plan`: the owner saves the plan from the guided editor, or confirms a scan. */
export const SaveRunPlanRequestSchema = z.object({
  plan: RunPlanSchema,
  scope: z.union([z.literal('project'), z.object({ workstationId: z.uuid() })]).default('project'),
  source: z.enum(['owner', 'scan']).default('owner'),
  proposalId: z.uuid().optional(),
});
export type SaveRunPlanRequest = z.infer<typeof SaveRunPlanRequestSchema>;

/** `POST /api/projects/:id/run-plan/test`: start the app once from these steps (saved or not) on a workstation. */
export const TestRunPlanRequestSchema = z.object({
  workstationId: z.uuid(),
  /** Absent: the plan that is saved for that workstation (its own, else the project's). */
  plan: RunPlanSchema.optional(),
});
export type TestRunPlanRequest = z.infer<typeof TestRunPlanRequestSchema>;

export const SetupScanRequestSchema = z.object({
  area: SetupAreaSchema,
  workstationId: z.uuid().optional(),
  /** Anything the user wants DevOps to know ("the website is in web/"). */
  note: z.string().max(2000).optional(),
});
export type SetupScanRequest = z.infer<typeof SetupScanRequestSchema>;
export const SetupScanResponseSchema = z.object({ requestId: z.uuid() });

export const ProposalsQuerySchema = z.object({ area: SetupAreaSchema.optional() });
export const ProposalsResponseSchema = z.object({ proposals: z.array(ProposalDtoSchema) });

export const ResolveProposalRequestSchema = z.object({ outcome: z.enum(['accepted', 'dismissed']) });
export type ResolveProposalRequest = z.infer<typeof ResolveProposalRequestSchema>;
