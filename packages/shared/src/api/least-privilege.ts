import { z } from 'zod';
import { IsoTime } from './common.ts';

/**
 * Super admin least privilege (R17): the shapes of the routes that replaced the super admin's direct powers. The
 * platform sees counts and signatures; the people an organization's data belongs to see the detail.
 */

// ------------------------------------------------------------------------------------- runner telemetry (R17-4)

/**
 * `GET /api/platform/runner-errors`: what the platform needs to spot a bad release. No message and no stack: only
 * the signature, the versions, the counts and up to five stack frames that pass a strict pattern (function name and
 * a module path inside the runner, no user paths).
 */
export const RunnerErrorSummarySchema = z.object({
  signature: z.string(),
  firstVersion: z.string(),
  lastVersion: z.string(),
  workstationCount: z.number().int(),
  occurrences: z.number().int(),
  firstSeenAt: IsoTime,
  lastSeenAt: IsoTime,
  topFrames: z.array(z.string()),
});
export type RunnerErrorSummary = z.infer<typeof RunnerErrorSummarySchema>;

/** `GET /api/platform/devops-audit`: DevOps command counts per runner version and platform; never a command. */
export const DevopsAuditCountSchema = z.object({
  runnerVersion: z.string().nullable(),
  platform: z.string().nullable(),
  total: z.number().int(),
  refused: z.number().int(),
  workstations: z.number().int(),
});
export type DevopsAuditCount = z.infer<typeof DevopsAuditCountSchema>;

/**
 * One DevOps command the runner's guard saw, for the organization's Owner (`GET /api/org/devops-audit`, the commands
 * of shifts of that organization) and the workstation's owner (`GET /api/workstations/:id/devops-audit`).
 */
export const DevopsCommandLogEntrySchema = z.object({
  id: z.string(),
  workstationId: z.uuid(),
  workstationName: z.string().nullable(),
  at: IsoTime,
  kind: z.string(),
  shiftKind: z.string().nullable(),
  decision: z.string(),
  rule: z.string().nullable(),
  command: z.string(),
});
export type DevopsCommandLogEntry = z.infer<typeof DevopsCommandLogEntrySchema>;
export const DevopsCommandLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  refused: z.enum(['true', 'false']).optional(),
});

// ------------------------------------------------------------------------------------ 2FA recovery (R17-2)

/** `POST /api/auth/2fa/recovery/start`: from the two-factor step of a sign-in (the password was right). */
export const StartTwoFactorRecoveryRequestSchema = z.object({ challenge: z.string().min(16).max(200) });
export const TwoFactorRecoveryTokenRequestSchema = z.object({ token: z.string().min(16).max(200) });

export const TwoFactorRecoveryStateSchema = z.enum([
  'awaiting_confirmation',
  'waiting',
  'done',
  'cancelled',
  'expired',
]);
export type TwoFactorRecoveryState = z.infer<typeof TwoFactorRecoveryStateSchema>;

/** `GET /api/auth/2fa/recovery/:token` and the confirm and cancel answers. */
export const TwoFactorRecoveryStatusSchema = z.object({
  state: TwoFactorRecoveryStateSchema,
  /** When two-factor login is removed (set once the link is confirmed). */
  effectiveAt: IsoTime.nullable(),
});
export type TwoFactorRecoveryStatus = z.infer<typeof TwoFactorRecoveryStatusSchema>;

// -------------------------------------------------------------------------- ownership transfer (R17-3)

export const OwnershipTransferDecisionSchema = z.enum([
  'approved',
  'vetoed',
  'automatic',
  'superseded',
  'void',
  'expired',
]);
export type OwnershipTransferDecision = z.infer<typeof OwnershipTransferDecisionSchema>;

/**
 * A platform ownership transfer waiting for the Owner (`GET /api/org/ownership-transfers/:id`, the Owner's consent page;
 * `pendingTransfer` on the platform organization detail).
 */
export const OwnershipTransferSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  orgName: z.string(),
  toUser: z.object({ id: z.uuid(), displayName: z.string(), email: z.string() }),
  reason: z.string().nullable(),
  requestedAt: IsoTime,
  effectiveAt: IsoTime,
  /**
   * False when it never takes effect by itself: the organization has deploy targets and its Owner is active, so only
   * the Owner's approval moves it (R17-3).
   */
  automatic: z.boolean(),
  decision: OwnershipTransferDecisionSchema.nullable(),
  decidedAt: IsoTime.nullable(),
});
export type OwnershipTransfer = z.infer<typeof OwnershipTransferSchema>;
