import { z } from 'zod';
import { ForgeKindSchema } from '../forge/index.ts';
import { WorkingBranchReason } from '../hygiene/index.ts';
import { ProjectKeySchema } from '../ids.ts';
import { BranchPrefixSchema, GitRefSchema, ProjectPathSchema, VaultFolderSchema } from '../safe.ts';
import { defineEvent, Id } from './define.ts';

/**
 * The work/personal domain and the priority tier of a project were dropped (the organization ranks its projects; see
 * `ProjectsRanked`). Old events still carry them, so the schemas accept and ignore both.
 */
const LegacyDomain = z.enum(['work', 'personal']).optional();
const LegacyTier = z.number().int().min(1).max(4).optional();

export const ProjectKind = z.enum(['project', 'interest']);
export type ProjectKind = z.infer<typeof ProjectKind>;

/** Mutable project columns (also the body of PATCH /api/projects/:id). */
export const ProjectChangesSchema = z
  .object({
    name: z.string().min(1).max(120),
    workflowKey: z.string().min(1),
    branchPrefix: BranchPrefixSchema,
    workingBranch: GitRefSchema,
    /** How finished work lands by default: merge into the working branch after review and test, or a pull request. */
    defaultCompletion: z.enum(['merge', 'pr']),
    subCategories: z.array(z.string()),
    vaultFolder: VaultFolderSchema.nullable(),
    architecturalGlobs: z.array(z.string()),
    e2eGlobs: z.array(z.string()),
  })
  .partial();
export type ProjectChanges = z.infer<typeof ProjectChangesSchema>;

/** What the event log may still carry in a `ProjectUpdated` from before the ranking: accepted, never applied. */
const ProjectUpdatedChangesSchema = ProjectChangesSchema.extend({
  domain: LegacyDomain,
  priorityTier: LegacyTier,
});

/** What happens to an open card the new workflow cannot place: it finishes where it is, or it is cancelled. */
export const ConvertCardDecision = z.enum(['keep', 'cancel']);
export type ConvertCardDecision = z.infer<typeof ConvertCardDecision>;

export const projectEvents = [
  defineEvent(
    'ProjectCreated',
    z.object({
      projectId: Id,
      orgId: Id,
      /** Absent on events from before organizations (then the org's owner, `orgId`, created it). */
      createdByUserId: Id.optional(),
      key: ProjectKeySchema,
      name: z.string().min(1),
      /** Legacy: events from before the organization ranked its projects carry a domain and a tier; both are ignored. */
      domain: LegacyDomain,
      workflowKey: z.string().min(1),
      priorityTier: LegacyTier,
      branchPrefix: z.string(),
      workingBranch: z.string().min(1),
      subCategories: z.array(z.string()),
      vaultFolder: z.string().nullable(),
      /** `interest`: the hidden backing project of an interest (docs/design/restructure.md D1). Absent: a visible project. */
      kind: ProjectKind.optional(),
      /** The full vault-relative folder (`interests/<slug>`); absent: `projects/<vault folder or key>`. */
      vaultDir: z.string().min(1).optional(),
      /** People added with the project besides the Owners and Admins of the organization (a shared or private interest). */
      members: z.array(z.object({ userId: Id, role: z.enum(['owner', 'manager']) })).optional(),
    }),
  ),
  /** Data migration: a feed project became the backing project of an interest (hidden from every project list). */
  defineEvent(
    'ProjectKindChanged',
    z.object({ projectId: Id, kind: ProjectKind, interestId: Id, vaultDir: z.string().min(1).optional() }),
  ),
  defineEvent('ProjectUpdated', z.object({ projectId: Id, changes: ProjectUpdatedChangesSchema })),
  /**
   * The Owner or an Admin ordered the organization's projects (drag and drop on the Projects page, or the data migration):
   * `projectIds` is the whole order, first = most important. The projector gives each its position as `rank`. A new
   * project (`ProjectCreated`) goes to the bottom. Interest projects are never ranked.
   */
  defineEvent(
    'ProjectsRanked',
    z.object({
      orgId: Id,
      projectIds: z.array(Id).min(1),
      rankedBy: Id.optional(),
      /** `migration`: the "drop personal" data migration put personal projects below the work ones. */
      reason: z.enum(['manual', 'migration']).default('manual'),
    }),
  ),
  /** The data migration pointed a project at its folder in the organization vault (`personal/projects/<key>` after the merge). */
  defineEvent('ProjectVaultDirSet', z.object({ projectId: Id, vaultDir: z.string().min(1) })),
  defineEvent(
    'ProjectRepoAdded',
    z.object({
      projectId: Id,
      repoId: Id,
      name: z.string().min(1),
      remoteUrl: z.string().min(1),
      remoteUrlNormalized: z.string().min(1),
      workingBranch: z.string().optional(),
      /** The git provider chosen for the repository (absent: detected from the URL). */
      forge: ForgeKindSchema.optional(),
      /** The sub directory of the repository the project lives in (absent: the repository root). */
      projectPath: ProjectPathSchema.optional(),
    }),
  ),
  /** The owner set (or cleared, `projectPath: null`) the sub directory of the repository the project lives in. */
  defineEvent(
    'ProjectRepoPathSet',
    z.object({ projectId: Id, repoId: Id, projectPath: ProjectPathSchema.nullable() }),
  ),
  /** The manager changed (or cleared, `forge: null`) the git provider of a repository. */
  defineEvent(
    'ProjectRepoForgeSet',
    z.object({ projectId: Id, repoId: Id, forge: ForgeKindSchema.nullable() }),
  ),
  defineEvent('ProjectRepoRemoved', z.object({ projectId: Id, repoId: Id })),
  /**
   * The project owner chose the reference repositories: other repositories (by project repository id) the project's
   * agents may read, read-only, in card work and in chats on the workstations that have them. `repoIds` is the whole
   * list (empty clears it). Nothing else on the workstation is ever opened.
   */
  defineEvent('ProjectReferenceReposSet', z.object({ projectId: Id, repoIds: z.array(Id), by: Id })),
  /**
   * The Owner or an Admin converted the project to another workflow (docs/design/restructure.md section 8, any to any).
   * One append with the repositories it adds (`ProjectRepoAdded`) and, for each open card the new workflow cannot place,
   * the decision: kept (it finishes on its own workflow and shows in extra board columns) or cancelled
   * (`CardCancelled`, reason "Project converted"). `repoIds` are the repositories added now, for the working-branch
   * question. Cards, notes, history and the vault folder are untouched.
   */
  defineEvent(
    'ProjectConverted',
    z.object({
      projectId: Id,
      fromWorkflowKey: z.string().min(1),
      toWorkflowKey: z.string().min(1),
      cardDecisions: z.array(z.object({ cardId: Id, decision: ConvertCardDecision })).default([]),
      cancelledCardIds: z.array(Id).default([]),
      repoIds: z.array(Id).default([]),
      note: z.string().max(500).optional(),
      by: Id,
    }),
  ),
  /**
   * A conversion that needs a repository none of the entries can supply yet: the Owner asked for new repositories, which
   * wait for the owner's approval and the runner. The project stays as it is until they exist, then `ProjectConverted`
   * follows.
   */
  defineEvent(
    'ProjectConversionRequested',
    z.object({
      projectId: Id,
      conversionId: Id,
      toWorkflowKey: z.string().min(1),
      cardDecisions: z.array(z.object({ cardId: Id, decision: ConvertCardDecision })).default([]),
      repoRequestIds: z.array(Id).min(1),
      note: z.string().max(500).optional(),
      by: Id,
    }),
  ),
  /** The waiting conversion was cancelled (by the Owner, or because every repository request was declined). */
  defineEvent(
    'ProjectConversionCancelled',
    z.object({ projectId: Id, conversionId: Id, by: Id.optional(), reason: z.string().optional() }),
  ),
  /**
   * The manager confirmed (or changed) the repository's working branch: the answer to the DevOps engineer's question on
   * the desk, or a change in the project settings. Hygiene commits and pushes only to a confirmed branch.
   */
  defineEvent(
    'ProjectRepoWorkingBranchSet',
    z.object({
      projectId: Id,
      repoId: Id,
      workingBranch: GitRefSchema,
      previousBranch: z.string().nullable().default(null),
      reason: WorkingBranchReason,
      setBy: Id,
      deskItemId: Id.optional(),
    }),
  ),
  /**
   * The project owner turned the large-merge approval off or on: with it on, a large-tier `merge` finalizes without the
   * manager's desk approval (default off). Recorded with who and when; shown in the project settings.
   */
  defineEvent(
    'ProjectMergePolicyChanged',
    z.object({ projectId: Id, mergeLargeWithoutApproval: z.boolean(), changedBy: Id }),
  ),
  /**
   * The project's Owner or an organization Owner/Admin turned the automatic "Full E2E suite after <card>" regression
   * card (spawned when a card is finalized) off or on. On by default.
   */
  defineEvent('ProjectFullSuiteSet', z.object({ projectId: Id, enabled: z.boolean(), by: Id })),
  /**
   * A project member set (or cleared, with null) the cap on shifts that may run at once on this project, whatever the
   * number of agents. Off by default (restructure.md decision 11).
   */
  defineEvent(
    'ProjectConcurrencyCapSet',
    z.object({ projectId: Id, cap: z.number().int().min(1).max(50).nullable(), by: Id }),
  ),
  /**
   * A member archived the project: it disappears from boards, pickers, the dispatcher, schedules, intake mapping and the
   * desk; history, cards and the vault folder are kept. The same append closes the open cards (`CardCancelled` with
   * cause `project_archived`), disables the schedules and dismisses the open desk items.
   */
  defineEvent('ProjectArchived', z.object({ projectId: Id, archivedBy: Id.optional() })),
  /** A member brought an archived project back. Closed cards stay closed and schedules stay disabled. */
  defineEvent('ProjectRestored', z.object({ projectId: Id, restoredBy: Id.optional() })),
  /**
   * The project owner deleted an archived project permanently. The projector removes every row of the project; the
   * event (with the key and name, for the audit trail) and the project's earlier events stay in the append-only log,
   * and a projection rebuild replays this tombstone after them so the project is not resurrected.
   */
  defineEvent(
    'ProjectDeleted',
    z.object({ projectId: Id, key: z.string(), name: z.string(), deletedBy: Id }),
  ),
] as const;
