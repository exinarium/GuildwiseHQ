import { z } from 'zod';
import { CeoPolicySchema } from '../ceo/policy.ts';
import {
  type CeoSettingsSchema,
  type CeoTrainingSchema,
  UpdateCeoSettingsRequestSchema,
} from '../ceo/settings.ts';
import { type CeoMemoryKind, CeoTaskStatus } from '../events/ceo.ts';

/** The CEO page and its API (docs/design/ceo-agent-v2.md section 8). The Owner configures; Admins read. */

export const AppointCeoRequestSchema = z.object({
  workstationId: z.uuid(),
  name: z.string().trim().min(1).max(60).optional(),
  acknowledgeUnsandboxed: z.boolean().optional(),
});
export type AppointCeoRequest = z.infer<typeof AppointCeoRequestSchema>;

export const PauseCeoRequestSchema = z.object({ reason: z.string().trim().max(500).optional() });

export const UpdateCeoPolicyRequestSchema = z.object({
  policy: CeoPolicySchema,
  /** Delegating an owner-reserved matter needs this explicit confirmation. */
  confirmDelegation: z.boolean().optional(),
  note: z.string().max(500).optional(),
});
export type UpdateCeoPolicyRequest = z.infer<typeof UpdateCeoPolicyRequestSchema>;

export { UpdateCeoSettingsRequestSchema };

export const CeoTrainingRequestSchema = z.object({ action: z.enum(['graduate', 'extend', 'restart']) });

export const MoveCeoRequestSchema = z.object({
  workstationId: z.uuid(),
  acknowledgeUnsandboxed: z.boolean().optional(),
});

export const CeoActionsQuerySchema = z.object({
  class: z.string().max(60).optional(),
  mode: z.enum(['decided', 'recommended', 'refused']).optional(),
  subject: z.string().max(100).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  before: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CeoActionsQuery = z.infer<typeof CeoActionsQuerySchema>;

export const CeoIdParamsSchema = z.object({ id: z.uuid() });

export const CreateCeoMemoryRequestSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  scope: z.string().max(100).default('org'),
});
export const PatchCeoMemoryRequestSchema = z.object({
  text: z.string().trim().min(1).max(1000).optional(),
  scope: z.string().max(100).optional(),
  confirm: z.boolean().optional(),
});

export const CreateCeoTaskRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  request: z.string().max(4000).optional(),
  due: z.iso.datetime().optional(),
});
export const PatchCeoTaskRequestSchema = z.object({
  status: CeoTaskStatus.optional(),
  note: z.string().max(4000).optional(),
  title: z.string().trim().min(1).max(300).optional(),
});

// --------------------------------------------------------------------------------------------- responses

export type CeoState = 'none' | 'active' | 'paused' | 'offline' | 'disabled';

export interface CeoStatusDto {
  /** The organization has (had) a CEO. */
  hired: boolean;
  state: CeoState;
  offlineReason: string | null;
  isOwner: boolean;
  canPause: boolean;
  agent: {
    id: string;
    name: string;
    avatarSeed: string;
    avatarStyle: string;
    model: string;
    runtime: string;
    workstationId: string | null;
    workstationName: string | null;
  } | null;
  training: z.infer<typeof CeoTrainingSchema> & { daysLeft: number };
  scores: Array<{ class: string; agreed: number; total: number }>;
  totals: { agreed: number; total: number };
  pendingWakes: number;
  running: { since: string; purpose: string } | null;
  openTasks: number;
  spend: { currency: string; todayMicros: number; monthMicros: number; orgMonthMicros: number };
  lastReportAt: string | null;
  policyVersion: number;
  /** Decisions undone in the last 7 days, of those decided. */
  undone7d: { undone: number; decided: number };
  /** The owner's workstations that could host the CEO (for the Workstations tab and the appoint dialog). */
  workstations: Array<{ id: string; name: string; online: boolean; capable: boolean; current: boolean }>;
}

export interface CeoSettingsDto {
  settings: z.infer<typeof CeoSettingsSchema>;
  canEdit: boolean;
}
export interface CeoPolicyDto {
  policy: z.infer<typeof CeoPolicySchema>;
  defaults: z.infer<typeof CeoPolicySchema>;
  canEdit: boolean;
}

export interface CeoActionDto {
  id: string;
  at: string;
  class: string;
  classLabel: string;
  action: string;
  mode: 'decided' | 'recommended' | 'refused';
  status: 'done' | 'recommended' | 'refused' | 'undone';
  subjectKind: string;
  subjectId: string;
  subjectLabel: string;
  reason: string;
  confidence: number;
  evidence: string[];
  policyVersion: number;
  verdictReason: string;
  cause: string | null;
  untrusted: boolean;
  undo: {
    available: boolean;
    kind: 'inverse' | 'compensating' | null;
    label: string | null;
    reason: string | null;
  };
  deskItemId: string | null;
  response: string | null;
  responseNote: string | null;
  responseChoice: string | null;
  undoneAt: string | null;
  acceptedFrom: string | null;
}
export interface CeoActionsResponse {
  actions: CeoActionDto[];
  next: string | null;
}

export interface CeoMemoryDtoApi {
  id: string;
  kind: z.infer<typeof CeoMemoryKind>;
  scope: string;
  source: string;
  sourceRef: string;
  confidence: number;
  status: string;
  observations: number;
  class: string | null;
  text: string;
  quote: string;
  createdAt: string;
  lastConfirmedAt: string | null;
}

export interface CeoTaskDtoApi {
  id: string;
  title: string;
  request: string;
  status: z.infer<typeof CeoTaskStatus>;
  threadId: string | null;
  dueAt: string | null;
  watch: Array<{ kind: string; id: string }>;
  notes: Array<{ at: string; by: string; note: string }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

export const CeoChatResponseSchema = z.object({ threadId: z.uuid() });
export const CeoUndoResponseSchema = z.object({
  kind: z.enum(['inverse', 'compensating']),
  message: z.string(),
});
