import { z } from 'zod';
import {
  DevOpsRequestContextSchema,
  DevOpsRequester,
  DevOpsRequestOrigin,
  DevOpsRequestStatus,
} from '../events/devops.ts';
import { IsoTime } from './common.ts';

export const DevOpsRequestDtoSchema = z.object({
  id: z.uuid(),
  workstationId: z.uuid(),
  workstationName: z.string(),
  devopsAgentId: z.uuid(),
  devopsAgentName: z.string(),
  threadId: z.uuid(),
  requestedBy: DevOpsRequester,
  cardId: z.uuid().nullable(),
  cardRef: z.string().nullable(),
  summary: z.string(),
  status: DevOpsRequestStatus,
  /** Set while `needs_approval` (and kept for the record after it was answered). */
  approval: z
    .object({
      deskItemId: z.uuid(),
      action: z.string(),
      reason: z.string(),
      commands: z.array(z.string()),
      resolution: z.enum(['approved', 'rejected']).nullable(),
      /** G-Q8: two-party approval on a member's workstation. Optional so older rows still parse. */
      managerApproved: z.boolean().optional(),
      workstationUserAgreed: z.boolean().optional(),
    })
    .nullable(),
  resultSummary: z.string().nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type DevOpsRequestDto = z.infer<typeof DevOpsRequestDtoSchema>;
export const DevOpsRequestsResponseSchema = z.object({ requests: z.array(DevOpsRequestDtoSchema) });

export const DevOpsThreadMessageSchema = z.object({
  id: z.uuid(),
  authorKind: z.enum(['user', 'agent', 'system']),
  authorName: z.string(),
  kind: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: IsoTime,
});
export const EnvironmentChangeDtoSchema = z.object({
  id: z.uuid(),
  summary: z.string(),
  commands: z.array(z.string()),
  createdAt: IsoTime,
});
export const DevOpsRequestDetailSchema = z.object({
  request: DevOpsRequestDtoSchema,
  messages: z.array(DevOpsThreadMessageSchema),
  changes: z.array(EnvironmentChangeDtoSchema),
});
export type DevOpsRequestDetail = z.infer<typeof DevOpsRequestDetailSchema>;

/** `POST /api/devops/requests`. */
export const CreateDevOpsRequestSchema = z.object({
  workstationId: z.uuid(),
  summary: z.string().min(1).max(20000),
  cardId: z.uuid().optional(),
  origin: DevOpsRequestOrigin.optional(),
  context: DevOpsRequestContextSchema.optional(),
});
export type CreateDevOpsRequest = z.infer<typeof CreateDevOpsRequestSchema>;

export const DevOpsRequestsQuerySchema = z.object({
  workstationId: z.uuid().optional(),
  status: DevOpsRequestStatus.optional(),
});

/** `PATCH /api/workstations/:id/devops-access`. */
// Explicit optional fields: `DevOpsAccessSchema.partial()` would still fill the defaults and reset what was not sent.
export const PatchDevOpsAccessRequestSchema = z.object({
  allowInstall: z.boolean().optional(),
  allowDocker: z.boolean().optional(),
  allowedPaths: z.array(z.string()).optional(),
  sudo: z.boolean().optional(),
});
export type PatchDevOpsAccessRequest = z.infer<typeof PatchDevOpsAccessRequestSchema>;

/** `POST /api/devops/requests/:id/resolve` (also what the M2 desk resolve calls for `subkind: 'devops'`). */
export const ResolveDevOpsApprovalRequestSchema = z.object({
  resolution: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).optional(),
});
export type ResolveDevOpsApprovalRequest = z.infer<typeof ResolveDevOpsApprovalRequestSchema>;
