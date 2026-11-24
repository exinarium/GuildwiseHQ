import { z } from 'zod';
import { BriefAttachmentSchema } from '../attachments/index.ts';
import { DevOpsAccessSchema, DevOpsRequester } from '../events/devops.ts';
import { HygieneReportSchema, HygieneSpecSchema } from '../hygiene/index.ts';
import { RunDeclaredServiceSchema, RunPlanSchema } from '../runs/plan.ts';
import { RunPurposeSchema } from '../runs/types.ts';
import { SetupAreaSchema } from '../setup/proposal.ts';

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

/** The workstation's DevOps switches a request can be blocked by (`workstations.devops_access`). */
export const DEVOPS_SWITCHES = ['allowInstall', 'allowDocker', 'allowedPaths'] as const;
export type DevopsSwitch = (typeof DEVOPS_SWITCHES)[number];
/** The switch names exactly as the Workstations page shows them. */
export const DEVOPS_SWITCH_LABEL: Readonly<Record<DevopsSwitch, string>> = {
  allowInstall: 'Install packages and tools',
  allowDocker: 'Docker',
  allowedPaths: 'Writable paths outside the agent sandbox',
};

export const DevopsApprovalDataSchema = z.object({
  action: z.string().min(1).max(2000),
  reason: z.string().min(1).max(20000),
  commands: z.array(z.string()).default([]),
  /**
   * UAT 1.10.0 finding 3: the workstation switch that is off and blocks the request (`aom devops-approval --blocked-by
   * install|docker|paths`). The request then waits for that switch instead of an approval.
   */
  blockedBy: z.enum(DEVOPS_SWITCHES).optional(),
});
/** A DevOps "approval" whose action starts with "Question:" is a question for the escalation chain, not an approval. */
export const DEVOPS_QUESTION_PREFIX = 'Question:';
export const isDevopsQuestion = (action: string): boolean => /^\s*question:/i.test(action);

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
  /**
   * Guides outside the run worktrees, read by the runner: the BUILD.md found in folders above the clones, the project's
   * "Build guide" setting (`configured`, replaces discovery) or README files (`readme`, only when no BUILD.md exists
   * anywhere). `path` is absolute on the workstation, nearest first; `repoIds` are the repositories it was found for.
   */
  buildGuides: z
    .array(
      z.object({
        path: z.string(),
        content: z.string(),
        origin: z.enum(['parent', 'configured', 'readme']),
        repoIds: z.array(z.uuid()).default([]),
      }),
    )
    .default([]),
  /**
   * Where each repository's checkout of the user lives on the workstation (the clone) and where the run worktree is:
   * a guide that names the first means the second. Filled by the runner.
   */
  pathMap: z
    .array(z.object({ repoId: z.uuid(), clonePath: z.string(), worktreePath: z.string() }))
    .default([]),
});
export type DevopsRun = z.infer<typeof DevopsRunSchema>;

/**
 * A "Scan with DevOps" request (docs/design/deploy-run-ux-design.md section 5): a READ-ONLY look at the project that ends
 * with `aom setup propose`. `clonePath` is filled by the runner (where the user's checkout of each repository lives).
 */
export const DevopsScanSchema = z.object({
  area: SetupAreaSchema,
  projectKey: z.string(),
  projectName: z.string(),
  repos: z.array(
    z.object({
      repoId: z.uuid(),
      name: z.string(),
      remoteUrlNormalized: z.string(),
      projectPath: z.string().optional(),
      workingBranch: z.string().optional(),
      clonePath: z.string().optional(),
    }),
  ),
  runInstructions: z.string().default(''),
  repoInstructions: z.array(z.object({ repoId: z.uuid(), name: z.string(), text: z.string() })).default([]),
  /** The run plan in force for this project (project-wide), so the scan can build on it. */
  currentPlan: RunPlanSchema.nullable().default(null),
  /** Anything the user wrote in the scan dialog. */
  note: z.string().max(2000).optional(),
  /** `area: deploy`: the targets, what is set up today and the latest probes. */
  deploy: z
    .object({
      targets: z.array(
        z.object({
          name: z.string(),
          kind: z.enum(['local_docker', 'remote_ssh']),
          host: z.string().nullable(),
          appUrl: z.string().nullable(),
          production: z.boolean(),
          workstationName: z.string().nullable(),
        }),
      ),
      /** The guided setup in `delivery/setup.json` today (text), or null. */
      currentSetup: z.string().nullable(),
      /** The hand-written recipe summary when the recipe is not a guided one. */
      currentRecipe: z.string().nullable(),
      /** Latest probe reports, as JSON text each (names and shapes only). */
      probes: z.array(z.object({ label: z.string(), json: z.string() })),
    })
    .optional(),
});
export type DevopsScan = z.infer<typeof DevopsScanSchema>;

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
      /** The card's work reference (same as ShiftBrief.card.workRef): the intake ticket key or the internal ref. */
      workRef: z.string().optional(),
      /** `workRef` is the client's ticket, not the internal card ref. Absent: older servers. */
      isClientRef: z.boolean().optional(),
      title: z.string(),
      cardType: z.string().optional(),
      stage: z.string().optional(),
      status: z.string().optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
      project: z.object({ key: z.string(), name: z.string() }).optional(),
      repo: z.string().optional(),
      /** The card repository's normalized remote: the runner runs a request on an app repository as the app. */
      remoteUrlNormalized: z.string().max(500).optional(),
      /** Files attached to the card (`aom card attachments` copies them next to the shift). */
      attachments: z.array(BriefAttachmentSchema).optional(),
      /** Latest comments, oldest first. */
      comments: z
        .array(z.object({ authorName: z.string(), kind: z.string(), body: z.string(), at: z.iso.datetime() }))
        .optional(),
    })
    .optional(),
  workstationName: z.string(),
  /**
   * 1.10.0 (R18-T): the request text was written by the owner of this workstation (a person, not an agent or a schedule).
   * Absent or false: the prompt fences the request as text from someone else.
   */
  fromWorkstationOwner: z.boolean().optional(),
  /**
   * 1.10.0 (R18-T): standing orders of the organization, its projects and the DevOps role that the workstation owner did
   * not write. They are shown fenced, as context; only `brief.standingOrders` (the owner's own) bind a DevOps shift.
   */
  contextOrders: z.array(z.object({ title: z.string(), body: z.string() })).optional(),
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
  /** The card's project does not require the owner's approval for merges: merge conflicts in the card worktree are yours. */
  mergeApprovalWaived: z.boolean().optional(),
  /**
   * uat-runner-fixes-3: set by the server only for a conflict request it filed itself (G-Q2, `origin = 'conflict'`), never
   * from request text. The runner lets this one card branch move forward (a fast-forward to the resolution) in this one
   * card's worktree; every other card worktree and card branch stays untouched by DevOps whatever the request says.
   */
  conflictCard: z.object({ ref: z.string().max(100), branch: z.string().max(300) }).optional(),
  /** Repository hygiene: the repositories of this workstation to tidy (see `aom hygiene run`). */
  hygiene: HygieneSpecSchema.optional(),
  /** A `run` request: the environment to bring up (see `aom run`). */
  run: DevopsRunSchema.optional(),
  /** A scan request (`run_scan`, `deploy_scan`): read-only, ends with `aom setup propose`. */
  scan: DevopsScanSchema.optional(),
  /**
   * The kind of a scan request, set by the server whatever the brief holds. The runner makes the shift read-only from this
   * (fail closed: a scan whose brief could not be built is still read-only).
   */
  scanKind: z.enum(['run_scan', 'deploy_scan']).optional(),
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

/** Is this switch on in `access`? */
export function devopsSwitchOn(access: z.infer<typeof DevOpsAccessSchema>, sw: DevopsSwitch): boolean {
  return sw === 'allowedPaths' ? access.allowedPaths.length > 0 : access[sw] === true;
}

/**
 * The switch that is off and blocks a DevOps approval request (UAT 1.10.0 finding 3): the one the agent named
 * (`blockedBy`), else Install or Docker when the request is about installing or about Docker and that switch is off.
 * Null when nothing switched off explains it (then it is a real approval).
 */
export function blockedSwitch(
  access: z.infer<typeof DevOpsAccessSchema>,
  data: Pick<DevopsApprovalData, 'action' | 'reason' | 'commands' | 'blockedBy'>,
): DevopsSwitch | null {
  const t = `${data.action}\n${data.reason}\n${data.commands.join('\n')}`.toLowerCase();
  // something destructive or that runs downloaded code is an approval whatever the switches say, also when the agent
  // names a switch itself (REVIEW B1)
  if (/\b(sudo|delete|destroy|wipe|format|rm|uninstall|drop|force|curl|wget)\b|\|\s*(sh|bash)\b/.test(t))
    return null;
  if (data.blockedBy) return devopsSwitchOn(access, data.blockedBy) ? null : data.blockedBy;
  if (/\bdocker\b/.test(t) && !access.allowDocker) return 'allowDocker';
  if (/\b(install|installing|npm i|apt|brew|pip install|toolchain)\b/.test(t) && !access.allowInstall)
    return 'allowInstall';
  return null;
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
