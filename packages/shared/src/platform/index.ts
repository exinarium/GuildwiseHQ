import { z } from 'zod';
import { globToRegExp, type HighRiskCategory, highRiskCategoriesOf } from '../workflows/high-risk.ts';

export * from './sanitize.ts';

/**
 * The platform team (Lean Team v3, docs/ARCHITECTURE.md "Platform team"): one organisation and project designated by the
 * super admin fixes Guildwise's own bugs. Shared constants and API shapes.
 */

/** Desk `subkind` values of the platform team (all raised on the platform organisation's desk, except the grant request). */
export const PLATFORM_DESK_SUBKIND = {
  /** A bug card was filed (coalesced per signature while open). */
  bugFiled: 'platform_bug',
  /** A scoped pause started or ended (coalesced per scope). */
  pause: 'platform_pause',
  /** A high-risk deploy needs the platform organisation's approval. */
  deployApproval: 'platform_deploy_approval',
  /** A deploy with downtime needs an explicit go-ahead. */
  downtimeApproval: 'platform_downtime_approval',
  /** A deploy that needed no approval was recorded (the audit trail report). */
  deployReport: 'platform_deploy_report',
  /** The platform team asks a client organisation for more diagnostics (raised on the CLIENT organisation's desk). */
  grantRequest: 'platform_grant_request',
  /** A runner version pin was set or cleared. */
  runnerPin: 'platform_runner_pin',
} as const;

export const PLATFORM_APPROVAL_SUBKINDS: ReadonlySet<string> = new Set([
  PLATFORM_DESK_SUBKIND.deployApproval,
  PLATFORM_DESK_SUBKIND.downtimeApproval,
  PLATFORM_DESK_SUBKIND.grantRequest,
]);

export const BugSourceSchema = z.enum([
  'runner_error',
  'server_5xx',
  'loop',
  'rejection_storm',
  'role_smoke',
  'agent',
  'manual',
]);
export type BugSource = z.infer<typeof BugSourceSchema>;

export const BugSeveritySchema = z.enum(['unrated', 'critical', 'degraded', 'minor']);
export type BugSeverity = z.infer<typeof BugSeveritySchema>;

export const BugStatusSchema = z.enum(['open', 'fixed', 'invalid']);
export type BugStatus = z.infer<typeof BugStatusSchema>;

export const FixSizeSchema = z.enum(['small', 'medium', 'large']);
export type FixSize = z.infer<typeof FixSizeSchema>;

/** The same failure this many times is a critical bug (design 8.3). */
export const CRITICAL_REPEATS = 3;
/** A runner error counts up on its card; the counter crossing one of these raises a note on the card. */
export const BUG_COUNTER_MILESTONES = [3, 10, 25, 100, 500, 2000];
/** At most this many NEW bug cards per hour; further bugs are recorded and filed later (no flooding). */
export const INTAKE_NEW_CARDS_PER_HOUR = 12;
/** Rejections on one workstation inside the window that make a storm. */
export const REJECTION_STORM = { count: 8, windowMinutes: 30 } as const;
/** A grant of more diagnostics lasts this long unless the client organisation picks less. */
export const GRANT_DEFAULT_HOURS = 24;
export const GRANT_MAX_HOURS = 72;

// ----------------------------------------------------------------------------------------------- pauses

export const PauseScopeSchema = z
  .object({
    projectId: z.uuid().nullable().default(null),
    workflowKey: z.string().min(1).max(80).nullable().default(null),
    stageId: z.string().min(1).max(80).nullable().default(null),
    workstationId: z.uuid().nullable().default(null),
  })
  .refine((s) => s.projectId || s.workflowKey || s.stageId || s.workstationId, {
    message: 'a pause needs at least one of project, workflow, stage or workstation',
  });
export type PauseScope = z.infer<typeof PauseScopeSchema>;

export const PlatformPauseDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid().nullable(),
  projectKey: z.string().nullable(),
  workflowKey: z.string().nullable(),
  stageId: z.string().nullable(),
  workstationId: z.uuid().nullable(),
  workstationName: z.string().nullable(),
  reason: z.string(),
  source: z.enum(['auto', 'manual']),
  severity: BugSeveritySchema,
  bugCardId: z.uuid().nullable(),
  bugCardRef: z.string().nullable(),
  createdAt: z.iso.datetime(),
  resumedAt: z.iso.datetime().nullable(),
  resumeReason: z.string().nullable(),
});
export type PlatformPauseDto = z.infer<typeof PlatformPauseDtoSchema>;

export const CreatePlatformPauseRequestSchema = z.object({
  projectId: z.uuid().nullable().optional(),
  workflowKey: z.string().min(1).max(80).nullable().optional(),
  stageId: z.string().min(1).max(80).nullable().optional(),
  workstationId: z.uuid().nullable().optional(),
  reason: z.string().trim().min(3).max(500),
  bugCardId: z.uuid().optional(),
});
export type CreatePlatformPauseRequest = z.infer<typeof CreatePlatformPauseRequestSchema>;

export const ResumePlatformPauseRequestSchema = z.object({ reason: z.string().trim().max(500).optional() });

// ----------------------------------------------------------------------------------------------- settings

export const PlatformTeamSettingsSchema = z.object({
  orgId: z.uuid().nullable(),
  orgName: z.string().nullable(),
  projectId: z.uuid().nullable(),
  projectKey: z.string().nullable(),
  projectName: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
export type PlatformTeamSettings = z.infer<typeof PlatformTeamSettingsSchema>;

/** `PUT /api/platform/team`: designate (both ids) or clear (orgId null). */
export const SetPlatformTeamRequestSchema = z.object({
  orgId: z.uuid().nullable(),
  projectId: z.uuid().nullable().optional(),
});
export type SetPlatformTeamRequest = z.infer<typeof SetPlatformTeamRequestSchema>;

// ----------------------------------------------------------------------------------------------- bugs

export const PlatformBugDtoSchema = z.object({
  signature: z.string(),
  source: BugSourceSchema,
  title: z.string(),
  severity: BugSeveritySchema,
  status: BugStatusSchema,
  fixSize: FixSizeSchema,
  occurrences: z.number().int(),
  cardId: z.uuid().nullable(),
  cardRef: z.string().nullable(),
  cardStatus: z.string().nullable(),
  clientOrgId: z.uuid().nullable(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  /** The sanitised diagnostics (signature, top frames, counts, versions). Never more without a grant. */
  diagnostics: z.record(z.string(), z.unknown()),
});
export type PlatformBugDto = z.infer<typeof PlatformBugDtoSchema>;

/** The architect's triage (`aom bug triage`, or a platform manager through the API). */
export const TriageBugRequestSchema = z
  .object({
    verdict: z.enum(['invalid', 'valid']),
    severity: z.enum(['critical', 'degraded', 'minor']).optional(),
    size: FixSizeSchema.optional(),
    reason: z.string().trim().min(3).max(2000).optional(),
  })
  .refine((b) => b.verdict === 'valid' || !!b.reason, {
    message: 'a reason is required to close a bug as invalid',
  })
  .refine((b) => b.verdict === 'invalid' || !!b.severity, { message: 'set a severity for a valid bug' });
export type TriageBugRequest = z.infer<typeof TriageBugRequestSchema>;

// ----------------------------------------------------------------------------------------------- deploys

/** Which part of the fix diff makes a deploy high risk (design 13: auth/secrets, data/migrations, tenancy/billing). */
export type RiskCategory = 'auth_permissions_secrets' | 'data_migrations' | 'tenancy_billing';

/** One definition of "high risk" for cards and deploys: the shared list in `workflows/high-risk.ts`. */
const CATEGORY: Record<HighRiskCategory, RiskCategory> = {
  auth: 'auth_permissions_secrets',
  data: 'data_migrations',
  tenancy: 'tenancy_billing',
};

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

export interface DeployRisk {
  high: boolean;
  categories: RiskCategory[];
  /** The changed files that made it high risk. */
  paths: string[];
}

/** Server-side classification of a fix diff by changed file paths (a caller's own claim is never trusted). */
export function classifyDeployRisk(changedFiles: string[]): DeployRisk {
  const categories = new Set<RiskCategory>();
  const paths: string[] = [];
  for (const raw of changedFiles) {
    const file = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    for (const cat of highRiskCategoriesOf(file)) {
      categories.add(CATEGORY[cat]);
      if (!paths.includes(file)) paths.push(file);
    }
  }
  return { high: categories.size > 0, categories: [...categories], paths };
}

export const DeployCheckRequestSchema = z.object({
  /** The version being deployed (a runner or server version label, or a commit). */
  version: z.string().trim().min(1).max(80),
  fromVersion: z.string().trim().max(80).optional(),
  /** The bug card this fix belongs to (its bug may be pausing work). */
  bugCardId: z.uuid().optional(),
  /** Paths changed by the fix diff; the server classifies the risk from them. */
  changedFiles: z.array(z.string().max(500)).max(5000),
  /** The deploy takes the service down for a while. */
  downtime: z.boolean().default(false),
  reviewApproved: z.boolean().default(false),
  testsPassed: z.boolean().default(false),
  uatPassed: z.boolean().default(false),
  /** Where to roll back to (recorded in the audit trail). */
  rollbackPath: z.string().max(500).optional(),
  diffSummary: z.string().max(2000).optional(),
});
export type DeployCheckRequest = z.infer<typeof DeployCheckRequestSchema>;

export const DeployDecisionSchema = z.object({
  allowed: z.boolean(),
  risk: z.enum(['low', 'high']),
  riskCategories: z.array(z.string()),
  riskPaths: z.array(z.string()),
  /** What is still needed: `review`, `tests`, `uat`, `high_risk_approval`, `downtime_approval`. */
  missing: z.array(z.string()),
  /** Pending approval desk items (on the platform organisation's desk). */
  pendingApprovalIds: z.array(z.uuid()),
  /** True when the fix pauses work and so goes live without approval; the platform organisation is informed. */
  fixesPausingBug: z.boolean(),
  reason: z.string(),
});
export type DeployDecision = z.infer<typeof DeployDecisionSchema>;

export const RecordDeployRequestSchema = DeployCheckRequestSchema.extend({
  outcome: z.enum(['deployed', 'rolled_back', 'failed']).default('deployed'),
  deployedAt: z.iso.datetime().optional(),
  note: z.string().max(2000).optional(),
});
export type RecordDeployRequest = z.infer<typeof RecordDeployRequestSchema>;

export const PlatformDeployAuditDtoSchema = z.object({
  id: z.number().int(),
  at: z.iso.datetime(),
  kind: z.enum(['check', 'deploy', 'approval', 'rollback']),
  version: z.string(),
  fromVersion: z.string().nullable(),
  risk: z.enum(['low', 'high']),
  riskCategories: z.array(z.string()),
  downtime: z.boolean(),
  allowed: z.boolean().nullable(),
  outcome: z.string().nullable(),
  bugCardId: z.uuid().nullable(),
  approvedBy: z.string().nullable(),
  rollbackPath: z.string().nullable(),
  reason: z.string().nullable(),
});
export type PlatformDeployAuditDto = z.infer<typeof PlatformDeployAuditDtoSchema>;

// ----------------------------------------------------------------------------------------------- grants

export const GrantStatusSchema = z.enum(['requested', 'approved', 'denied', 'revoked', 'expired']);
export type GrantStatus = z.infer<typeof GrantStatusSchema>;

export const RequestGrantRequestSchema = z.object({
  signature: z.string().min(1).max(200),
  reason: z.string().trim().min(3).max(1000),
  hours: z.number().int().min(1).max(GRANT_MAX_HOURS).optional(),
});
export type RequestGrantRequest = z.infer<typeof RequestGrantRequestSchema>;

export const PlatformGrantDtoSchema = z.object({
  id: z.uuid(),
  signature: z.string(),
  bugCardId: z.uuid().nullable(),
  clientOrgId: z.uuid(),
  clientOrgName: z.string().nullable(),
  status: GrantStatusSchema,
  reason: z.string(),
  hours: z.number().int(),
  requestedAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type PlatformGrantDto = z.infer<typeof PlatformGrantDtoSchema>;

// ----------------------------------------------------------------------------------------------- safe mode

/** `PUT /api/platform-team/runner-pin`: pin one workstation (or all: `workstationId` null) to a runner version; version null clears. */
export const SetRunnerPinRequestSchema = z.object({
  workstationId: z.uuid().nullable(),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/)
    .nullable(),
  reason: z.string().trim().max(500).optional(),
});
export type SetRunnerPinRequest = z.infer<typeof SetRunnerPinRequestSchema>;

export const RunnerPinDtoSchema = z.object({
  workstationId: z.uuid().nullable(),
  version: z.string(),
  reason: z.string().nullable(),
  pinnedAt: z.iso.datetime(),
});
export type RunnerPinDto = z.infer<typeof RunnerPinDtoSchema>;

/** What a runner is told: the version it must run (null: no pin, follow the latest release). */
export const RunnerPinSchema = z.object({ version: z.string().max(40) }).nullable();
export type RunnerPinSetting = z.infer<typeof RunnerPinSchema>;
