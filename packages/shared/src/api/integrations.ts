import { z } from 'zod';
import {
  IntegrationKindIdSchema,
  IntegrationPromptSchema,
  IntegrationStatusSchema,
  IntegrationsPolicySchema,
  SealedEnvelopeSchema,
} from '../integrations/schema.ts';
import { IsoTime } from './common.ts';

/** One request or sign-in session of the Integrations page (`integration_requests`). Never holds a secret. */
export const IntegrationRequestDtoSchema = z.object({
  id: z.string(),
  op: z.enum(['connect', 'session', 'test', 'remove']),
  kind: IntegrationKindIdSchema,
  instance: z.string(),
  method: z.string().nullable(),
  /** pending | awaiting_user | awaiting_code | completing | done | failed | cancelled | expired */
  state: z.string(),
  prompt: IntegrationPromptSchema.nullable(),
  status: IntegrationStatusSchema.nullable(),
  error: z.string().nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  expiresAt: IsoTime,
});
export type IntegrationRequestDto = z.infer<typeof IntegrationRequestDtoSchema>;

/** `GET /api/workstations/:id/integrations`. */
export const WorkstationIntegrationsResponseSchema = z.object({
  workstation: z.object({ id: z.uuid(), name: z.string() }),
  /** The runner's key (null: it has not announced one). The page shows the fingerprint and seals with `publicKey`. */
  key: z.object({ keyId: z.string(), publicKey: z.string() }).nullable(),
  serverTime: IsoTime,
  runner: z.object({
    connected: z.boolean(),
    version: z.string().nullable(),
    /** Null: an older runner. The statuses then come from the legacy reports and are read-only. */
    integrationsVersion: z.number().int().nullable(),
    policy: IntegrationsPolicySchema.nullable(),
  }),
  integrations: z.array(IntegrationStatusSchema),
  activeSessions: z.array(IntegrationRequestDtoSchema),
  /** True when the statuses were derived from the legacy reports of an older runner. */
  legacy: z.boolean(),
});
export type WorkstationIntegrationsResponse = z.infer<typeof WorkstationIntegrationsResponseSchema>;

/** `GET /api/integrations/workstations`: the chooser. */
export const IntegrationWorkstationSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  connected: z.boolean(),
  lastSeenAt: IsoTime.nullable(),
  needsAttention: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export const IntegrationWorkstationsResponseSchema = z.object({
  workstations: z.array(IntegrationWorkstationSummarySchema),
});
export type IntegrationWorkstationSummary = z.infer<typeof IntegrationWorkstationSummarySchema>;

/** `POST /api/workstations/:id/integrations/connect`: only the sealed envelope carries the values. */
export const IntegrationConnectRequestSchema = z.object({
  requestId: z.uuid(),
  kind: IntegrationKindIdSchema,
  instance: z.string().max(200),
  method: z.string().min(1).max(40),
  envelope: SealedEnvelopeSchema,
});
export type IntegrationConnectRequest = z.infer<typeof IntegrationConnectRequestSchema>;

/** `POST /api/workstations/:id/integrations/sessions`. */
export const IntegrationSessionRequestSchema = z.object({
  kind: IntegrationKindIdSchema,
  instance: z.string().max(200),
  method: z.string().min(1).max(40),
  pre: z.record(z.string().max(100), z.string().max(300)).optional(),
});
export type IntegrationSessionRequest = z.infer<typeof IntegrationSessionRequestSchema>;

/** `POST .../sessions/:sid/input`. */
export const IntegrationInputRequestSchema = z.object({ envelope: SealedEnvelopeSchema });
export type IntegrationInputRequest = z.infer<typeof IntegrationInputRequestSchema>;

/** `POST .../test` and `.../remove`. */
export const IntegrationActionRequestSchema = z.object({
  requestId: z.uuid(),
  kind: IntegrationKindIdSchema,
  instance: z.string().max(200),
});
export type IntegrationActionRequest = z.infer<typeof IntegrationActionRequestSchema>;

export const IntegrationRequestAcceptedSchema = z.object({ id: z.string(), state: z.string() });
export type IntegrationRequestAccepted = z.infer<typeof IntegrationRequestAcceptedSchema>;
