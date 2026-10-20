import { z } from 'zod';

/** One fact a satisfied gate requirement rests on (see `evaluateGate`). */
export const GateEvidenceSchema = z.object({
  requirement: z.string().max(200),
  ref: z.string().max(80).nullable(),
  detail: z.string().max(300),
});

/** Who asked for, or released, a deploy. */
export const DeployActor = z.object({
  kind: z.enum(['owner', 'admin', 'ceo', 'devops', 'trigger', 'system']),
  id: z.string().nullable().default(null),
  name: z.string().max(120).optional(),
});
export type DeployActor = z.infer<typeof DeployActor>;

export const DeployOrigin = z.object({
  /** For a CEO call: the provenance the server derived (owner turn, order turn, wake). */
  provenance: z.enum(['owner', 'order', 'wake', 'session', 'trigger']).optional(),
  untrusted: z.boolean().default(false),
  turnId: z.uuid().optional(),
  wakeBatchId: z.uuid().optional(),
  note: z.string().max(300).optional(),
});
