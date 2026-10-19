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

/** Where an "Ask DevOps" request was started (additive; absent on older clients). */
export const DevOpsRequestOrigin = z.enum([
  'app',
  'palette',
  'card',
  'desk',
  'workstation',
  'chat',
  'conflict',
]);
export type DevOpsRequestOrigin = z.infer<typeof DevOpsRequestOrigin>;

/** The page, project, card and so on the user was looking at when they asked; rendered into the DevOps brief. */
export const DevOpsRequestContextSchema = z.object({
  route: z.string().max(500).optional(),
  projectId: z.uuid().optional(),
  workstationId: z.uuid().optional(),
  cardId: z.uuid().optional(),
  deskItemId: z.uuid().optional(),
  repoId: z.uuid().optional(),
  errorText: z.string().max(4000).optional(),
  /** A `run` request ("Run this branch"): the run environment the DevOps engineer sets up. */
  requestKind: z.literal('run').optional(),
  envId: z.uuid().optional(),
  /** The saved run plan was replayed first and failed: why, with the tail of the failing log (for the DevOps brief). */
  replayFailure: z.string().max(12000).optional(),
});
export type DevOpsRequestContext = z.infer<typeof DevOpsRequestContextSchema>;

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
      /** "Ask DevOps": where the request came from and what the user was looking at (additive). */
      origin: DevOpsRequestOrigin.optional(),
      context: DevOpsRequestContextSchema.optional(),
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
      /** The DevOps engineer asked a question (answered through the escalation chain), not for an approval. */
      question: z.boolean().optional(),
    }),
  ),
  /** G-Q2: DevOps tries to resolve a card's rebase/merge conflict on a branch; the card waits on the request. */
  defineEvent(
    'ConflictAttemptStarted',
    z.object({
      cardId: Id,
      requestId: Id,
      attempt: z.number().int().positive(),
      source: z.enum(['rebase', 'finalize']),
    }),
  ),
  /**
   * G-Q8: one party of a two-party approval said yes (an Owner/Admin approved, or the workstation's own user agreed);
   * the request waits for the other. Not terminal.
   */
  defineEvent(
    'DevOpsApprovalAgreed',
    z.object({
      requestId: Id,
      deskItemId: Id,
      party: z.enum(['manager', 'workstation_user']),
      by: Id,
    }),
  ),
  /** The approval was answered; `approved` re-queues the request with the approval attached. */
  defineEvent(
    'DevOpsApprovalResolved',
    z.object({
      requestId: Id,
      deskItemId: Id,
      resolution: z.enum(['approved', 'rejected']),
      /** Absent when the server approved by itself (`auto`). */
      resolvedBy: Id.optional(),
      /** The server approved it by itself (a merge-conflict resolution on a project that waives merge approval). */
      auto: z.boolean().optional(),
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
