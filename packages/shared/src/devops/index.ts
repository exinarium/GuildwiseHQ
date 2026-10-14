import { z } from 'zod';
import { BriefAttachmentSchema } from '../attachments/index.ts';
import { DevOpsAccessSchema, DevOpsRequester } from '../events/devops.ts';
import { HygieneReportSchema, HygieneSpecSchema } from '../hygiene/index.ts';
import { RunDeclaredServiceSchema, RunPlanSchema } from '../runs/plan.ts';
import { RunPurposeSchema } from '../runs/types.ts';

/**
 * DevOps shifts (docs/ARCHITECTURE.md section 16.2). A DevOps shift has no card: it works one request and ends with
 * `aom devops-done` (EnvironmentChanged) or `aom devops-approval` (DevOpsApprovalNeeded). Both are ordinary
 * terminal outcome reports with these ids.
 */
export const DEVOPS_OUTCOME_DONE = 'devops_done';
export const DEVOPS_OUTCOME_APPROVAL = 'devops_approval';

export const DevopsDoneDataSchema = z.object({
  summary: z.string().min(1).max(20000),
  commands: z.array(z.string()).default([]),
  /** Repository hygiene (`aom hygiene run`): what was done and found per repository. */
  hygiene: HygieneReportSchema.optional(),
});
export type DevopsDoneData = z.infer<typeof DevopsDoneDataSchema>;

export const DevopsApprovalDataSchema = z.object({
  action: z.string().min(1).max(2000),
  reason: z.string().min(1).max(20000),
  commands: z.array(z.string()).default([]),
});
export type DevopsApprovalData = z.infer<typeof DevopsApprovalDataSchema>;

/**
 * A `run` request ("Run this branch"): everything the DevOps engineer needs to bring one environment up
 * (docs/design/run-and-integration-tests.md section 2.3). `buildDocs` is filled by the runner, which finds BUILD.md in the
 * run worktrees; the server never reads repositories.
 */
export const DevopsRunSchema = z.object({
  envId: z.uuid(),
  purpose: RunPurposeSchema,
  projectKey: z.string(),
  projectName: z.string(),
  /** Repositories and the branch (and commit, once known) each runs at. */
  sources: z.array(
    z.object({
      repoId: z.uuid(),
      name: z.string(),
      branch: z.string(),
      projectPath: z.string().optional(),
      commit: z.string().nullable().optional(),
    }),
  ),
  /** The services asked for (empty: all). */
  services: z.array(z.string()).default([]),
  runInstructions: z.string().default(''),
  repoInstructions: z.array(z.object({ repoId: z.uuid(), name: z.string(), text: z.string() })).default([]),
  declared: z.array(RunDeclaredServiceSchema).default([]),
  /** The plan saved for this project on this workstation (absent: none yet), and how it ended last time. */
  currentPlan: RunPlanSchema.nullable().default(null),
  planStatus: z.enum(['active', 'stale', 'superseded']).nullable().default(null),
  /** The saved plan was tried first and failed (or was out of date): why, with the tail of the failing log. */
  replayFailure: z.string().max(12000).optional(),
  portRange: z.object({ from: z.number().int(), to: z.number().int() }),
  allowDocker: z.boolean().default(false),
  ttlAt: z.iso.datetime().nullable().default(null),
  /** BUILD.md of each repository (looked for in the project path, then the repository root); filled by the runner. */
  buildDocs: z.array(z.object({ repoId: z.uuid(), path: z.string(), content: z.string() })).default([]),
});
export type DevopsRun = z.infer<typeof DevopsRunSchema>;

/** The `devops` part of `shift.start` for `kind: 'devops'`. */
export const DevopsShiftSchema = z.object({
  requestId: z.uuid(),
  threadId: z.uuid(),
  summary: z.string(),
  requestedBy: DevOpsRequester,
  /**
   * The card the request was filed for (a card shift's `aom devops`, or "Ask DevOps" on a card). Besides the ref and
   * title it carries what the DevOps engineer needs to work for the card; `aom card show|comment|update` reach this one
   * card (the server only ever serves the request's own card). All but ref/title are additive.
   */
  card: z
    .object({
      ref: z.string(),
      title: z.string(),
      cardType: z.string().optional(),
      stage: z.string().optional(),
      status: z.string().optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
      project: z.object({ key: z.string(), name: z.string() }).optional(),
      repo: z.string().optional(),
      /** Files attached to the card (`aom card attachments` copies them next to the shift). */
      attachments: z.array(BriefAttachmentSchema).optional(),
      /** Latest comments, oldest first. */
      comments: z
        .array(z.object({ authorName: z.string(), kind: z.string(), body: z.string(), at: z.iso.datetime() }))
        .optional(),
    })
    .optional(),
  workstationName: z.string(),
  access: DevOpsAccessSchema,
  /** Set when the manager already approved the out-of-access action this request is resumed for. */
  approval: z
    .object({
      action: z.string(),
      reason: z.string(),
      commands: z.array(z.string()),
      note: z.string().optional(),
    })
    .optional(),
  /** Repository hygiene: the repositories of this workstation to tidy (see `aom hygiene run`). */
  hygiene: HygieneSpecSchema.optional(),
  /** A `run` request: the environment to bring up (see `aom run`). */
  run: DevopsRunSchema.optional(),
  /** Earlier messages of the request thread, oldest first. */
  history: z
    .array(z.object({ authorName: z.string(), kind: z.string(), body: z.string(), at: z.iso.datetime() }))
    .default([]),
});
export type DevopsShift = z.infer<typeof DevopsShiftSchema>;

/** Outcomes placed in the synthetic brief of a DevOps shift (the runner validates reports against them). */
export function devopsBriefOutcomes() {
  return [
    {
      id: DEVOPS_OUTCOME_DONE,
      label: 'Request completed (environment changed or nothing to change)',
      kind: 'success' as const,
      data: 'devopsDone',
    },
    {
      id: DEVOPS_OUTCOME_APPROVAL,
      label: 'Needs the manager: destructive or outside the granted access',
      kind: 'success' as const,
      data: 'devopsApproval',
    },
  ];
}

/** True when `summary` asks for something the granted `access` does not cover (used by the mock DevOps agent). */
export function needsApproval(access: z.infer<typeof DevOpsAccessSchema>, text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(sudo|delete|destroy|wipe|format|rm -rf|uninstall)\b/.test(t)) return !access.sudo;
  if (/\bdocker\b/.test(t) && /\b(install|setup|set up)\b/.test(t))
    return !(access.allowInstall && access.allowDocker);
  if (/\binstall\b/.test(t)) return !access.allowInstall;
  return false;
}

export * from './environment.ts';
