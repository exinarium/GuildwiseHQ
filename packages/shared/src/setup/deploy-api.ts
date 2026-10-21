import { z } from 'zod';
import { ChangeGroupSchema } from '../delivery/changes.ts';
import { DeployKeyDtoSchema } from '../delivery/connect.ts';
import {
  ConnectionStateSchema,
  ProbeErrorSchema,
  ProbeReportSchema,
  ProbeScopeSchema,
} from '../delivery/probe.ts';
import { DeliverySetupSchema } from '../delivery/setup.ts';
import { ProposalDtoSchema, ScanStateDtoSchema } from './api.ts';

/**
 * API of the guided deploy setup (docs/design/deploy-run-ux-design.md section 7.3):
 * `GET|PUT /api/projects/:id/delivery/setup`, `POST .../setup/preview|publish|dry-run|use-proposal`, `POST .../delivery/probe`.
 */

export const LintItemDtoSchema = z.object({
  level: z.enum(['error', 'warn']),
  code: z.string(),
  message: z.string(),
  env: z.string().optional(),
  path: z.string().optional(),
});

export const ChangeItemDtoSchema = z.object({
  group: ChangeGroupSchema,
  text: z.string(),
  env: z.string(),
  ref: z.string().optional(),
});

export const SetupTargetDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['local_docker', 'remote_ssh']),
  production: z.boolean(),
  workstationId: z.uuid().nullable(),
  workstationName: z.string().nullable(),
  workstationOnline: z.boolean().nullable(),
  host: z.string().nullable(),
  appUrl: z.string().nullable(),
  /** Can the deploying workstation sign in to the server? (`null`: never checked / not a server target.) */
  connection: z
    .object({
      state: ConnectionStateSchema,
      at: z.iso.datetime(),
      detail: z.string().nullable(),
      method: z.enum(['existing_alias', 'deploy_key']).optional(),
    })
    .nullable(),
  /** The dedicated Guildwise keys of this target (one per computer that connected), public parts only. */
  keys: z.array(DeployKeyDtoSchema).optional(),
});
export type SetupTargetDto = z.infer<typeof SetupTargetDtoSchema>;

export const SetupWorkstationDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  connected: z.boolean(),
  mine: z.boolean(),
  /** Answers `deploy.probe` and `recipe.write` (capability `deploy-setup:1`). */
  canProbe: z.boolean(),
  /** Why not, in a sentence; null when it can. */
  blocked: z.string().nullable(),
  /** Answers the guided-connect commands (capability `deploy-connect:1`). Absent from an older server. */
  canConnect: z.boolean().optional(),
});
export type SetupWorkstationDto = z.infer<typeof SetupWorkstationDtoSchema>;

export const SetupProbeDtoSchema = z.object({
  id: z.uuid(),
  targetId: z.uuid().nullable(),
  workstationId: z.uuid(),
  workstationName: z.string(),
  scope: ProbeScopeSchema,
  host: z.string().nullable(),
  at: z.iso.datetime(),
  report: ProbeReportSchema.nullable(),
  error: ProbeErrorSchema.nullable(),
  /** The error in plain words. */
  errorText: z.string().nullable(),
});
export type SetupProbeDto = z.infer<typeof SetupProbeDtoSchema>;

export const PublishStatusDtoSchema = z.object({
  setupHash: z.string(),
  commandId: z.string(),
  status: z.enum(['pending', 'written', 'failed']),
  error: z.string().nullable(),
  at: z.iso.datetime(),
});

export const SetupStateDtoSchema = z.object({
  /** The project owner role: may edit, probe, publish. */
  canEdit: z.boolean(),
  /** The organization Owner: the one who approves. */
  canApprove: z.boolean(),
  /** The wizard's work in progress. */
  draft: z
    .object({
      setup: z.unknown(),
      customScripts: z.record(z.string(), z.string()),
      proposalId: z.uuid().nullable(),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
  /** What `delivery/` holds now. */
  current: z.object({
    setup: DeliverySetupSchema.nullable(),
    /** The environments whose script was edited by hand (differs from what the setup compiles to). */
    handEdited: z.array(z.string()),
    recipePresent: z.boolean(),
    recipeStatus: z.string().nullable(),
    observedHash: z.string().nullable(),
    approvedHash: z.string().nullable(),
    lint: z.array(LintItemDtoSchema),
    /** Environment names that have a successful dry run of the observed version. */
    dryRunOk: z.array(z.string()),
    /** The recipe is not from the guided setup (written by DevOps or by hand): shown as a script. */
    custom: z.boolean(),
  }),
  publish: PublishStatusDtoSchema.nullable(),
  targets: z.array(SetupTargetDtoSchema),
  workstations: z.array(SetupWorkstationDtoSchema),
  probes: z.array(SetupProbeDtoSchema),
  /** Why guided setup cannot write files now ("the project has no vault"); null when it can. */
  writeBlocked: z.string().nullable(),
  scan: ScanStateDtoSchema.nullable(),
  scanProblem: z.string().nullable(),
  proposal: ProposalDtoSchema.nullable(),
  generator: z.string(),
  /** Servers whose steps use a compiler older than this server's: an improved version is available. */
  improvedAvailable: z.boolean().optional(),
});
export type SetupStateDto = z.infer<typeof SetupStateDtoSchema>;

export const SaveSetupDraftRequestSchema = z.object({
  setup: z.unknown(),
  customScripts: z.record(z.string(), z.string().max(200_000)).optional(),
  /** Files of `delivery/` that the guided setup does not make and the Owner chose to delete (everything else is kept). */
  removeFiles: z.array(z.string().max(200)).max(50).optional(),
});
export type SaveSetupDraftRequest = z.infer<typeof SaveSetupDraftRequestSchema>;

export const PreviewSetupRequestSchema = SaveSetupDraftRequestSchema;
export type PreviewSetupRequest = z.infer<typeof PreviewSetupRequestSchema>;

export const SetupPreviewDtoSchema = z.object({
  ok: z.boolean(),
  /** Why it cannot be compiled, in plain words. */
  issues: z.array(z.string()),
  hash: z.string().nullable(),
  files: z.array(z.object({ path: z.string(), mode: z.enum(['755', '644']), content: z.string() })),
  /** Files of hand-written scripts that stay as they are. */
  keep: z.array(z.string()),
  /**
   * Files in `delivery/` today that the guided setup does not generate (a smoke test, an old script). They are KEPT unless
   * their path is in the request's `removeFiles`; the page shows them so nothing disappears unseen.
   */
  unmodelled: z.array(z.string()).optional(),
  /** The ones the request asks to delete. */
  removing: z.array(z.string()).optional(),
  lint: z.array(LintItemDtoSchema),
  changes: z.array(ChangeItemDtoSchema),
  /** The generated files differ from what `delivery/` holds now (a save would be a new version). */
  differsFromCurrent: z.boolean(),
  /** Environments that still need a successful dry run before approval (after saving). */
  needsDryRun: z.array(z.string()),
});
export type SetupPreviewDto = z.infer<typeof SetupPreviewDtoSchema>;

export const PublishSetupRequestSchema = z.object({
  setup: z.unknown(),
  customScripts: z.record(z.string(), z.string().max(200_000)).optional(),
  removeFiles: z.array(z.string().max(200)).max(50).optional(),
  /** The hash the preview showed: a publish of anything else is refused. */
  setupHash: z.string().length(64),
});
export type PublishSetupRequest = z.infer<typeof PublishSetupRequestSchema>;
export const PublishSetupResponseSchema = z.object({ commandId: z.string(), hash: z.string() });

export const SetupDryRunRequestSchema = z.object({ env: z.string().min(1).max(40) });
export type SetupDryRunRequest = z.infer<typeof SetupDryRunRequestSchema>;

export const UseProposalRequestSchema = z.object({ proposalId: z.uuid() });

export const ProbeRequestSchema = z.object({
  scope: ProbeScopeSchema,
  targetId: z.uuid().optional(),
  /** `ssh_target`: the alias, when no target names it yet. */
  host: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .optional(),
  workstationId: z.uuid().optional(),
  /** Extra things to look at (the wizard's current answers). */
  hints: z
    .object({
      composeFiles: z.array(z.string().max(300)).max(10).optional(),
      dirs: z.array(z.string().max(300)).max(10).optional(),
      urls: z.array(z.string().max(300)).max(10).optional(),
    })
    .optional(),
});
export type ProbeRequest = z.infer<typeof ProbeRequestSchema>;
export const ProbeResponseSchema = z.object({ commandId: z.string(), workstationId: z.uuid() });
