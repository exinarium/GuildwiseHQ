import { z } from 'zod';
import { HygieneSpecSchema } from '../hygiene/index.ts';
import { defineEvent, Id } from './define.ts';

/** What the workstation's DevOps engineer may do without asking (`workstations.devops_access`). */
export const DevOpsAccessSchema = z.object({
  allowInstall: z.boolean().default(false),
  allowDocker: z.boolean().default(false),
  allowedPaths: z.array(z.string()).default([]),
  sudo: z.boolean().default(false),
});
export type DevOpsAccess = z.infer<typeof DevOpsAccessSchema>;
export const DEFAULT_DEVOPS_ACCESS: DevOpsAccess = {
  allowInstall: false,
  allowDocker: false,
  allowedPaths: [],
  sudo: false,
};

export const DevOpsRequester = z.object({
  kind: z.enum(['user', 'agent', 'system']),
  id: z.string().nullable(),
  name: z.string().optional(),
});
export type DevOpsRequester = z.infer<typeof DevOpsRequester>;

export const DevOpsRequestStatus = z.enum(['queued', 'running', 'needs_approval', 'done', 'failed']);
export type DevOpsRequestStatus = z.infer<typeof DevOpsRequestStatus>;

/** DevOps events (docs/ARCHITECTURE.md section 5.2, M3). Audience `org` of the workstation's owner. */
export const devopsEvents = [
  defineEvent(
    'DevOpsRequested',
    z.object({
      requestId: Id,
      workstationId: Id,
      devopsAgentId: Id,
      threadId: Id,
      requestedBy: DevOpsRequester,
      cardId: Id.optional(),
      summary: z.string().min(1).max(20000),
      /** A repository hygiene run (scheduled or started by the manager): the repositories it covers. */
      hygiene: HygieneSpecSchema.optional(),
    }),
  ),
  /** A DevOps shift for the request was dispatched to the runner (creates the shift row). */
  defineEvent(
    'DevOpsShiftDispatched',
    z.object({ requestId: Id, shiftId: Id, agentId: Id, workstationId: Id }),
  ),
  /** Additive: `changeId` makes the projection deterministic on replay. */
  defineEvent(
    'EnvironmentChanged',
    z.object({
      changeId: Id,
      requestId: Id.optional(),
      workstationId: Id,
      summary: z.string().min(1).max(20000),
      commands: z.array(z.string()).default([]),
    }),
  ),
  defineEvent(
    'DevOpsApprovalNeeded',
    z.object({
      requestId: Id,
      deskItemId: Id,
      action: z.string().min(1),
      reason: z.string().min(1),
      commands: z.array(z.string()).default([]),
    }),
  ),
  /** The approval was answered; `approved` re-queues the request with the approval attached. */
  defineEvent(
    'DevOpsApprovalResolved',
    z.object({
      requestId: Id,
      deskItemId: Id,
      resolution: z.enum(['approved', 'rejected']),
      resolvedBy: Id,
      note: z.string().optional(),
    }),
  ),
  /** The shift never started or was lost: back to the queue. */
  defineEvent('DevOpsRequestRequeued', z.object({ requestId: Id, reason: z.string() })),
  defineEvent(
    'DevOpsRequestCompleted',
    z.object({ requestId: Id, status: z.enum(['done', 'failed']), summary: z.string() }),
  ),
  defineEvent(
    'DevOpsAccessChanged',
    z.object({ workstationId: Id, access: DevOpsAccessSchema, changedBy: Id }),
  ),
] as const;
