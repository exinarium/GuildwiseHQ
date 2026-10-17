import { z } from 'zod';
import { isValidReportPath } from '../cards/fields.ts';
import { EnvironmentReportSchema, EnvStateSchema, RepoCloneStateSchema } from '../devops/environment.ts';
import { ConvertCardDecision, ProjectChangesSchema } from '../events/project.ts';
import {
  createFullNameError,
  detectForgeKind,
  ForgeKindSchema,
  GitAccessMethodSchema,
} from '../forge/index.ts';
import { ProjectKeySchema } from '../ids.ts';
import { McpServerCandidateDtoSchema } from '../mcp/index.ts';
import { RepoDescriptionSchema, RepoNameSchema, RepoVisibilitySchema, repoNameError } from '../repo/index.ts';
import {
  BranchPrefixSchema,
  GitRefSchema,
  ProjectPathSchema,
  RemoteUrlSchema,
  VaultFolderSchema,
} from '../safe.ts';
import { IsoTime } from './common.ts';
import { BudgetDtoSchema } from './costs.ts';
import { RepoSyncDtoSchema } from './workstations.ts';

export const ProjectRepoDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  remoteUrl: z.string(),
  remoteUrlNormalized: z.string(),
  /** The confirmed working branch; null until the manager named one (hygiene commits nothing then). */
  workingBranch: z.string().nullable(),
  removedAt: IsoTime.nullable(),
  /** The sub directory of the repository the project lives in; null: the repository root. */
  projectPath: z.string().nullable().optional(),
  /** The owner's access method for this repository (`ssh` or `https`); null: the workstation default of the host. */
  accessMethod: GitAccessMethodSchema.nullable().optional(),
  /** The main branch (where pull requests go) when the owner named one; null: the repository's default branch. */
  mainBranch: z.string().nullable().optional(),
  /** When the runner created the missing working branch, from which branch, and whether it was pushed; null: not (yet). */
  workingBranchCreated: z
    .object({ at: IsoTime, from: z.string(), pushed: z.boolean() })
    .nullable()
    .optional(),
  /** The pull request from the working branch to the main branch, the last time one was asked for. */
  releasePr: z
    .object({
      state: z.enum(['pending', 'opened', 'nothing', 'failed']),
      url: z.string().nullable(),
      message: z.string().nullable(),
      at: IsoTime,
    })
    .nullable()
    .optional(),
  /** The git provider in force: the manual choice, else detected from the URL. */
  forge: ForgeKindSchema.optional(),
  /** The manual choice (null: detected). */
  forgeOverride: ForgeKindSchema.nullable().optional(),
  /** Branches of the clone, as the last hygiene run saw them (the options of the working-branch question). */
  knownBranches: z.array(z.string()).optional(),
  /** When that list was last refreshed (absent: unknown, so it proves nothing about a branch missing). */
  knownBranchesAt: IsoTime.nullable().optional(),
  workingBranchSetAt: IsoTime.nullable().optional(),
  /** The open desk question that asks for this repository's working branch. */
  branchQuestionId: z.uuid().nullable().optional(),
  /** Where the DevOps engineers put this repository: one entry per workstation of the project (clone state). */
  setup: z
    .array(
      z.object({
        workstationId: z.uuid(),
        workstationName: z.string(),
        state: RepoCloneStateSchema,
        detail: z.string().nullable(),
        localPath: z.string().nullable(),
        updatedAt: IsoTime,
      }),
    )
    .optional(),
  /** The working branch against origin, per workstation that holds a clone (the runner's last check). */
  syncs: z
    .array(
      RepoSyncDtoSchema.extend({
        workstationId: z.uuid(),
        workstationName: z.string(),
        canSync: z.boolean(),
      }),
    )
    .optional(),
});
export type ProjectRepoDto = z.infer<typeof ProjectRepoDtoSchema>;

/** A repository of another project that this project's agents may read (or that could be picked). */
export const ReferenceRepoDtoSchema = z.object({
  repoId: z.uuid(),
  name: z.string(),
  projectId: z.uuid(),
  projectName: z.string(),
  /** Credentials are scrubbed from the URL. */
  remoteUrl: z.string(),
});
export type ReferenceRepoDto = z.infer<typeof ReferenceRepoDtoSchema>;

/** A repository cloned on a workstation (any clone under its repoRoots) that is, or could be, a reference repository. */
export const WorkstationRepoDtoSchema = z.object({
  workstationId: z.uuid(),
  workstationName: z.string(),
  localKey: z.string(),
  name: z.string(),
  /** Normalized remote (no credentials); null: the clone has no remote. */
  remoteUrl: z.string().nullable(),
});
export type WorkstationRepoDto = z.infer<typeof WorkstationRepoDtoSchema>;

/**
 * `PUT /api/projects/:id/reference-repos` (project owner): the whole list of reference repositories. `workstationRepos`
 * absent: the workstation clones already picked stay as they are.
 */
export const MAX_REFERENCE_REPOS = 20;
export const SetReferenceReposRequestSchema = z
  .object({
    repoIds: z.array(z.uuid()).max(MAX_REFERENCE_REPOS),
    workstationRepos: z
      .array(z.object({ workstationId: z.uuid(), localKey: z.string().min(1).max(500) }))
      .max(MAX_REFERENCE_REPOS)
      .optional(),
  })
  .refine((v) => v.repoIds.length + (v.workstationRepos?.length ?? 0) <= MAX_REFERENCE_REPOS, {
    message: `at most ${MAX_REFERENCE_REPOS} reference repositories`,
  });
export type SetReferenceReposRequest = z.infer<typeof SetReferenceReposRequestSchema>;

export const ProjectDtoSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  /** The organization that owns the project (guests see it as a label). */
  orgName: z.string().optional(),
  key: z.string(),
  name: z.string(),
  workflowKey: z.string(),
  /** M10: the department of the project's workflow (its type). */
  department: z.string().nullable().optional(),
  /** The place in the organization's ranking (1 = most important); null for a project that is not ranked (archived ones keep theirs). */
  rank: z.number().int().nullable().optional(),
  branchPrefix: z.string(),
  workingBranch: z.string(),
  /** How finished work lands unless a card says otherwise: `merge` (after review and test) or `pr`. */
  defaultCompletion: z.enum(['merge', 'pr']).optional(),
  /** Repository hygiene removes the branches of finished cards once their work is merged elsewhere (default on). */
  removeFinishedBranches: z.boolean().optional(),
  /** Prefix of pull request branches on the git host, `<prefix>/<ticket>`; empty means the default `feature`. */
  prBranchPrefix: z.string().optional(),
  subCategories: z.array(z.string()),
  vaultFolder: z.string().nullable(),
  /** The project has a knowledge vault (its own or the organization's); a vault report location needs one. */
  hasVault: z.boolean().optional(),
  architecturalGlobs: z.array(z.string()),
  e2eGlobs: z.array(z.string()),
  status: z.enum(['active', 'archived']),
  /** Owner-only setting: large-tier merges finalize without the manager's desk approval (default off). */
  mergeLargeWithoutApproval: z.boolean().optional(),
  /** Who last changed the setting and when (null: never). */
  mergeLargeChanged: z.object({ byName: z.string(), at: IsoTime }).nullable().optional(),
  /** Whether finishing a card automatically starts a full end-to-end test run card (default true). */
  fullSuiteAfterFinalize: z.boolean().optional(),
  /** Answers and orders of this project stay at project scope (the platform project): no org-wide promotion (default off). */
  decisionsProjectOnly: z.boolean().optional(),
  /** Test a card without a test environment: the tester runs what it can and records that none was used (default off). */
  testWithoutEnvironment: z.boolean().optional(),
  /** Manual QA after Finalize: the person who started a card tests it before it is done (default true). */
  manualQa: z.boolean().optional(),
  /** Architect settings: run Investigate & design before build by default (off unless the project opts in). */
  designStep: z.boolean().optional(),
  /** Merge the latest main branch into the working branch before work starts (default on). */
  mergeMainFirst: z.boolean().optional(),
  /** Where the architect's reports go: a folder in the repository (`repo`) or in the project vault (`vault`). */
  investigationPath: z.string().optional(),
  investigationLocation: z.enum(['repo', 'vault']).optional(),
  /** Optional cap on shifts running at once on this project; null: no cap (the default). */
  maxConcurrentShifts: z.number().int().nullable().optional(),
  /** The monthly budget and this month's spend (amounts hidden from guests); absent in lists that do not compute it. */
  budget: BudgetDtoSchema.optional(),
  /**
   * Backlog #73: the project's work is paused because the model usage limit was hit on the workstation(s) that run it;
   * work resumes at `until`. Absent when nothing is paused.
   */
  usageLimit: z
    .object({ until: IsoTime, workstationName: z.string(), label: z.string().nullable() })
    .nullable()
    .optional(),
  createdAt: IsoTime,
  /** The workflow the project was created with (`research` for research-first projects). */
  startedAs: z.string().nullable().optional(),
  convertedAt: IsoTime.nullable().optional(),
  /** Published research notes of the project (the Research tab shows when there are some, or it started as research). */
  publishedNotes: z.number().int().optional(),
  /** A conversion that waits for its new repositories. */
  pendingConversion: z
    .lazy(() => PendingConversionSchema)
    .nullable()
    .optional(),
  /** The requesting user's relation to the project. */
  myRole: z.enum(['owner', 'manager']),
});
export type ProjectDto = z.infer<typeof ProjectDtoSchema>;

/** `PUT /api/projects/:id/concurrency-cap`: a number of shifts, or null to remove the cap. */
export const SetConcurrencyCapRequestSchema = z.object({ cap: z.number().int().min(1).max(50).nullable() });
export type SetConcurrencyCapRequest = z.infer<typeof SetConcurrencyCapRequestSchema>;

export const ProjectMemberDtoSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  role: z.enum(['owner', 'manager']),
  status: z.enum(['invited', 'active', 'removed']),
});

/** `status` defaults to `active`: archived projects never appear unless asked for (`archived`, or `all`). */
export const ProjectsQuerySchema = z.object({
  department: z.string().optional(),
  status: z.enum(['active', 'archived', 'all']).optional(),
});
/** What archiving a project stops (shown in the confirmation dialog). */
export const ProjectImpactSchema = z.object({
  activeShifts: z.number().int(),
  openCards: z.number().int(),
  schedules: z.number().int(),
  openDeskItems: z.number().int(),
});
export type ProjectImpact = z.infer<typeof ProjectImpactSchema>;
/** Permanent delete: the caller types the project key, the server checks it matches. */
export const DeleteProjectRequestSchema = z.object({ confirmKey: z.string().min(1) });
export type DeleteProjectRequest = z.infer<typeof DeleteProjectRequestSchema>;
export const ProjectsResponseSchema = z.object({ projects: z.array(ProjectDtoSchema) });
export const ProjectDetailResponseSchema = z.object({
  project: ProjectDtoSchema,
  repos: z.array(ProjectRepoDtoSchema),
  /** The development environment of the project per workstation (toolchain installed, ready to build). */
  environments: z
    .array(
      z.object({
        workstationId: z.uuid(),
        workstationName: z.string(),
        state: EnvStateSchema,
        summary: z.string().nullable(),
        report: EnvironmentReportSchema.nullable(),
        updatedAt: IsoTime,
      }),
    )
    .default([]),
  members: z.array(ProjectMemberDtoSchema),
  /** Reference repositories: other projects' repositories this project's agents may read (read-only). */
  referenceRepos: z.array(ReferenceRepoDtoSchema).default([]),
  /** What the owner could still pick: repositories of the organization's other active projects (all of them for org owners and admins, else those the caller is an active member of; [] for non-owners). */
  referenceRepoCandidates: z.array(ReferenceRepoDtoSchema).default([]),
  /** Clones on workstations picked as reference repositories. */
  referenceWorkstationRepos: z.array(WorkstationRepoDtoSchema).default([]),
  /** Clones on the caller's own workstations they could pick ([] for non-owners). */
  workstationRepoCandidates: z.array(WorkstationRepoDtoSchema).default([]),
  /** Plugin MCP servers granted to the project's agents (names; everyone who can see the project reads them). */
  mcpServers: z.array(z.string()).default([]),
  /** The organization's Owner may change the grant; others read it. */
  canGrantMcpServers: z.boolean().default(false),
  /** What the Owner could grant: the plugin MCP servers their workstations report ([] for everyone else). */
  mcpServerCandidates: z.array(McpServerCandidateDtoSchema).default([]),
  /** The setting's change history, newest first (who turned it on or off, when). */
  mergePolicyHistory: z
    .array(z.object({ enabled: z.boolean(), byName: z.string(), at: IsoTime }))
    .default([]),
});
export type ProjectDetailResponse = z.infer<typeof ProjectDetailResponseSchema>;

export const CreateProjectRequestSchema = z.object({
  key: ProjectKeySchema,
  name: z.string().min(1).max(120),
  workflowKey: z.string().min(1).default('code'),
  branchPrefix: BranchPrefixSchema.default('aom/'),
  workingBranch: GitRefSchema.default('main'),
  subCategories: z.array(z.string()).default([]),
  vaultFolder: VaultFolderSchema.nullable().default(null),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/** `PUT /api/projects/:id/merge-policy` (owner only). */
/** `PUT /api/projects/:id/policy` (organization Owner, Admins and the project owner). At least one field. */
export const SetProjectPolicyRequestSchema = z
  .object({ decisionsProjectOnly: z.boolean().optional(), testWithoutEnvironment: z.boolean().optional() })
  .refine((v) => v.decisionsProjectOnly !== undefined || v.testWithoutEnvironment !== undefined, {
    message: 'nothing to change',
  });
export type SetProjectPolicyRequest = z.infer<typeof SetProjectPolicyRequestSchema>;
export const SetFullSuiteRequestSchema = z.object({ enabled: z.boolean() });
/** `PUT /api/projects/:id/architect-settings` (organization Owner, Admins and the project owner). */
export const SetArchitectSettingsRequestSchema = z.object({
  designStep: z.boolean(),
  mergeMainFirst: z.boolean(),
  investigationPath: z
    .string()
    .trim()
    .refine((p) => !p.startsWith('vault:') && isValidReportPath(p), 'a relative folder without ..'),
  investigationLocation: z.enum(['repo', 'vault']),
});
export type SetArchitectSettingsRequest = z.infer<typeof SetArchitectSettingsRequestSchema>;
export const SetMergePolicyRequestSchema = z.object({ mergeLargeWithoutApproval: z.boolean() });
export type SetMergePolicyRequest = z.infer<typeof SetMergePolicyRequestSchema>;

export const PatchProjectRequestSchema = ProjectChangesSchema;
export type PatchProjectRequest = z.infer<typeof PatchProjectRequestSchema>;

/**
 * `PUT /api/projects/ranking` (Owner and Admins): the organization's active projects in the new order, most important
 * first. It must name every active project of the organization once (a stale list is refused with 409 and the page reloads).
 */
export const RankProjectsRequestSchema = z.object({ projectIds: z.array(z.uuid()).min(1).max(500) });
export type RankProjectsRequest = z.infer<typeof RankProjectsRequestSchema>;

export const AddRepoRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    remoteUrl: RemoteUrlSchema,
    workingBranch: GitRefSchema.optional(),
    /** The sub directory of the repository the project lives in (empty: the repository root). */
    projectPath: ProjectPathSchema.optional(),
    /** `ssh` or `https` for this repository; absent: the workstation default of the git host. */
    accessMethod: GitAccessMethodSchema.optional(),
    /** The main branch (where pull requests go); absent: the repository's default branch. */
    mainBranch: GitRefSchema.optional(),
    /** The git provider, when it cannot be detected from the URL (the manual override). */
    forge: ForgeKindSchema.optional(),
    /**
     * "Create new": the repository does not exist yet. `remoteUrl` is where it will live; the DevOps engineer creates it
     * on the code host (its CLI or API) and clones it. Without this the repository is cloned (it must exist).
     */
    create: z
      .object({
        name: z.string().min(3).max(400),
        visibility: RepoVisibilitySchema.default('private'),
        description: RepoDescriptionSchema.optional(),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.create) return;
    const kind = v.forge ?? detectForgeKind(v.remoteUrl);
    const err =
      kind === 'github' || kind === 'git'
        ? repoNameError(v.create.name)
        : createFullNameError(kind, v.create.name);
    if (err) ctx.addIssue({ code: 'custom', path: ['create', 'name'], message: err });
  });
export type AddRepoRequest = z.infer<typeof AddRepoRequestSchema>;
export const RepoParamsSchema = z.object({ id: z.uuid(), repoId: z.uuid() });

// ------------------------------------------------------------------------------------- conversion

/** A repository the conversion adds: an existing remote, or a new one the owner approves and the runner creates. */
export const ConvertRepoSchema = z.union([
  z.object({
    name: z.string().min(1).max(120),
    remoteUrl: RemoteUrlSchema,
    workingBranch: GitRefSchema.optional(),
  }),
  z.object({
    create: z.object({
      /** `owner/repo` as `aom repo create` takes it. */
      name: RepoNameSchema,
      visibility: RepoVisibilitySchema.default('private'),
      description: RepoDescriptionSchema.optional(),
    }),
  }),
]);
export type ConvertRepo = z.infer<typeof ConvertRepoSchema>;

/**
 * `POST /api/projects/:id/convert` (Owner and Admins). `cardDecisions` names the decision for single cards; every other
 * open card the new workflow cannot place gets `defaultDecision` (keep: it finishes on its own workflow).
 */
export const ConvertProjectRequestSchema = z.object({
  toWorkflowKey: z.string().min(1),
  repos: z.array(ConvertRepoSchema).max(10).default([]),
  defaultDecision: ConvertCardDecision.default('keep'),
  cardDecisions: z.record(z.uuid(), ConvertCardDecision).default({}),
  note: z.string().max(500).optional(),
});
export type ConvertProjectRequest = z.infer<typeof ConvertProjectRequestSchema>;

export const ConvertPreviewQuerySchema = z.object({ toWorkflowKey: z.string().min(1) });

/** An open card the target workflow cannot place, with what happens to it by default. */
export const ConvertCardDtoSchema = z.object({
  id: z.uuid(),
  ref: z.string(),
  title: z.string(),
  cardType: z.string(),
  workflowKey: z.string(),
  stage: z.string(),
  status: z.string(),
  claimed: z.boolean(),
});
export type ConvertCardDto = z.infer<typeof ConvertCardDtoSchema>;

/** `GET /api/projects/:id/convert-preview?toWorkflowKey=`: what the dialog shows before the Owner confirms. */
export const ConvertPreviewSchema = z.object({
  fromWorkflowKey: z.string(),
  toWorkflowKey: z.string(),
  toWorkflowName: z.string(),
  /** The target workflow needs repositories (at least one must be added or requested). */
  usesRepos: z.boolean(),
  activeRepos: z.number().int(),
  publishedNotes: z.number().int(),
  /** Open cards of other workflows than the target: each is kept or cancelled. */
  foreignCards: z.array(ConvertCardDtoSchema),
  placedCards: z.number().int(),
  /** The next step usually taken from the current workflow (research: code), for the dialog's guidance. */
  suggested: z.string().nullable(),
});
export type ConvertPreview = z.infer<typeof ConvertPreviewSchema>;

/** A conversion waiting for its repositories (shown on the project). */
export const PendingConversionSchema = z.object({
  conversionId: z.uuid(),
  toWorkflowKey: z.string(),
  requests: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      status: z.enum(['pending', 'approved', 'rejected', 'created', 'failed']),
      deskItemId: z.uuid(),
      error: z.string().nullable(),
    }),
  ),
});
export type PendingConversion = z.infer<typeof PendingConversionSchema>;

export const ConvertResultSchema = z.object({
  /** `converted`: done now. `waiting`: the repositories are requested; it completes when they exist. */
  status: z.enum(['converted', 'waiting']),
  cancelledCards: z.number().int(),
  keptCards: z.number().int(),
  repoRequests: z.array(z.object({ requestId: z.uuid(), name: z.string(), deskItemId: z.uuid() })),
});
export type ConvertResult = z.infer<typeof ConvertResultSchema>;

/** `PATCH /api/projects/:id/repos/:repoId`: the git provider of a repository (null: detect it from the URL again). */
/** Either field may be sent: the git provider (null: detect), the project path (null or empty: the repository root). */
export const PatchRepoRequestSchema = z
  .object({
    forge: ForgeKindSchema.nullable().optional(),
    projectPath: ProjectPathSchema.nullable().optional(),
    /** `ssh` or `https` for this repository; null: follow the workstation default of the git host. */
    accessMethod: GitAccessMethodSchema.nullable().optional(),
    /** The main branch (null: the repository's default branch). */
    mainBranch: GitRefSchema.nullable().optional(),
  })
  .refine(
    (b) =>
      b.forge !== undefined ||
      b.projectPath !== undefined ||
      b.accessMethod !== undefined ||
      b.mainBranch !== undefined,
    { message: 'send forge, projectPath, accessMethod or mainBranch' },
  );

/** `POST /api/projects/:id/repos/:repoId/release-pr` answer: the request was queued for the repository's workstation. */
export const ReleasePrRequestedSchema = z.object({ requestId: z.uuid() });
export type ReleasePrRequested = z.infer<typeof ReleasePrRequestedSchema>;
export type PatchRepoRequest = z.infer<typeof PatchRepoRequestSchema>;
