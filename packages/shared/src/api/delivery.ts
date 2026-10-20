import { z } from 'zod';
import { GateSchema } from '../delivery/gate.ts';
import type { LintItem, Recipe } from '../delivery/recipe.ts';
import { SECRET_NAME } from '../delivery/recipe.ts';
import { IsoTime } from './common.ts';

/**
 * Delivery recipes, the release queue and the deploy runs (docs/design/ceo-front-door.md section 9 and 14.2). Nothing here
 * carries a secret value or a script's content.
 */

export const DeliveryRecipeStatusSchema = z.enum([
  'observed',
  'approved',
  'changed_unapproved',
  'rejected',
  'absent',
]);

export interface DeliveryRecipeDto {
  id: string;
  status: z.infer<typeof DeliveryRecipeStatusSchema>;
  present: boolean;
  observedHash: string | null;
  observedCommit: string | null;
  approvedHash: string | null;
  approvedCommit: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  version: number;
  observedAt: string | null;
  /** The parsed, normalized recipe as observed in the vault now. */
  recipe: Recipe | null;
  /** The recipe as the Owner approved it (what runs). */
  approvedRecipe: Recipe | null;
  lint: LintItem[];
  fileCount: number;
  /** What changed since the approved version, in plain words (environments and files). */
  changes: string[];
}

export const DeliveryModeSchema = z.enum(['instructions', 'recipe']);
export const SetDeliveryModeRequestSchema = z.object({ mode: DeliveryModeSchema });
export type SetDeliveryModeRequest = z.infer<typeof SetDeliveryModeRequestSchema>;

/** The hash is the one the Owner saw: approving anything else is refused. */
export const ApproveRecipeRequestSchema = z.object({ hash: z.string().length(64) });
export const RejectRecipeRequestSchema = z.object({
  hash: z.string().length(64),
  reason: z.string().trim().max(500).optional(),
});

export const DeliverySecretStatusSchema = z.object({
  workstationId: z.uuid(),
  workstationName: z.string(),
  name: z.string(),
  setAt: IsoTime,
});
export type DeliverySecretStatus = z.infer<typeof DeliverySecretStatusSchema>;

export const SetDeploySecretRequestSchema = z.object({
  projectId: z.uuid(),
  name: z.string().regex(SECRET_NAME),
  keyId: z.string().min(1).max(100),
  ciphertext: z.string().min(1).max(4000),
});
export type SetDeploySecretRequest = z.infer<typeof SetDeploySecretRequestSchema>;

export const DeployRunDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  projectKey: z.string(),
  env: z.string(),
  targetName: z.string(),
  targetId: z.uuid().nullable(),
  commit: z.string().nullable(),
  deployedCommit: z.string().nullable(),
  status: z.enum([
    'requested',
    'waiting_release',
    'queued',
    'running',
    'succeeded',
    'failed',
    'refused',
    'cancelled',
  ]),
  waitingFor: z.enum(['owner', 'ceo']).nullable(),
  releasedByPolicy: z.enum(['owner', 'ceo', 'auto']),
  trigger: z.string(),
  trial: z.boolean(),
  dryRun: z.boolean(),
  requestedBy: z.object({ kind: z.string(), id: z.string().nullable(), name: z.string().optional() }),
  releasedBy: z
    .object({ kind: z.string(), id: z.string().nullable(), name: z.string().optional() })
    .nullable(),
  recipeHash: z.string(),
  evidence: z.array(z.object({ requirement: z.string(), ref: z.string().nullable(), detail: z.string() })),
  missing: z.array(z.string()),
  refusal: z.string().nullable(),
  refusalDetail: z.string().nullable(),
  health: z.object({ ok: z.boolean(), detail: z.string().optional() }).nullable(),
  smoke: z.object({ ok: z.boolean(), detail: z.string().optional() }).nullable(),
  summary: z.string().nullable(),
  logTail: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: IsoTime,
  startedAt: IsoTime.nullable(),
  finishedAt: IsoTime.nullable(),
});
export type DeployRunDto = z.infer<typeof DeployRunDtoSchema>;

/** One ready release: a commit of an environment with one row per server (the chooser). */
export const ReleaseQueueItemSchema = z.object({
  projectId: z.uuid(),
  projectKey: z.string(),
  env: z.string(),
  commit: z.string().nullable(),
  waitingFor: z.enum(['owner', 'ceo']),
  requestedAt: IsoTime,
  /** A release the gate no longer allows (the window closed, a freeze): still listed, with why. */
  gateNow: z.object({ satisfied: z.boolean(), missing: z.array(z.string()) }),
  targets: z.array(
    z.object({
      runId: z.uuid(),
      targetId: z.uuid().nullable(),
      targetName: z.string(),
      production: z.boolean(),
      host: z.string().nullable(),
      workstationName: z.string().nullable(),
    }),
  ),
});
export type ReleaseQueueItem = z.infer<typeof ReleaseQueueItemSchema>;

export const ReleaseRequestSchema = z.object({ runIds: z.array(z.uuid()).min(1).max(30) });
export const DeployRequestSchema = z.object({
  env: z.string().min(1).max(40),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  /** Target names; absent: every target of the environment. */
  targets: z.array(z.string().max(80)).max(20).optional(),
});
export type DeployRequest = z.infer<typeof DeployRequestSchema>;

export const DeployRunOutcomeSchema = z.object({
  runId: z.uuid(),
  target: z.string(),
  status: z.enum(['queued', 'waiting_release', 'refused']),
  waitingFor: z.enum(['owner', 'ceo']).optional(),
  refusal: z.string().optional(),
  detail: z.string().optional(),
  missing: z.array(z.string()).optional(),
});
export const DeployResultSchema = z.object({
  runs: z.array(DeployRunOutcomeSchema),
  message: z.string(),
});
export type DeployResult = z.infer<typeof DeployResultSchema>;

export const GatePresetSchema = z.object({
  name: z.string(),
  gate: GateSchema,
  updatedAt: IsoTime.nullable(),
});
export type GatePresetDto = z.infer<typeof GatePresetSchema>;
export const SetGatePresetRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  gate: GateSchema,
});
export const GateBindingSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid().nullable(),
  repoId: z.uuid().nullable(),
  envMatch: z.enum(['production', '*']),
  preset: z.string(),
});
export type GateBindingDto = z.infer<typeof GateBindingSchema>;
export const SetGateBindingRequestSchema = z
  .object({
    projectId: z.uuid().optional(),
    repoId: z.uuid().optional(),
    envMatch: z.enum(['production', '*']),
    /** null removes the binding. */
    preset: z.string().min(1).max(60).nullable(),
  })
  .refine((b) => !!b.projectId !== !!b.repoId, { message: 'bind to a project or a repository' });
export type SetGateBindingRequest = z.infer<typeof SetGateBindingRequestSchema>;

export interface DeliverySettingsResponse {
  mode: 'instructions' | 'recipe';
  /** The project vault the recipe lives in; the UI says who backs it up. */
  vault: { storage: 'git' | 'local'; name: string; folder: string } | null;
  recipe: DeliveryRecipeDto | null;
  canApprove: boolean;
  canChangeMode: boolean;
  /** Per environment of the approved (else observed) recipe: who releases, where, and the secrets it names. */
  environments: Array<{
    name: string;
    targets: Array<{ name: string; production: boolean; exists: boolean }>;
    releasedBy: 'owner' | 'ceo' | 'auto';
    triggers: string[];
    gate: string;
    secrets: string[];
  }>;
  secrets: DeliverySecretStatus[];
}
