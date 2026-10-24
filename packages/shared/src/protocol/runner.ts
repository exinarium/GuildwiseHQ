import { z } from 'zod';
import { BriefAttachmentSchema } from '../attachments/index.ts';
import {
  PackCheckPayloadSchema,
  PacksReportSchema,
  PacksSyncPayloadSchema,
  ProjectCapabilitiesReportSchema,
} from '../capabilities/pack-wire.ts';
import { CapabilityMetaSchema } from '../capabilities/parse.ts';
import { CHANGED_PATHS_MAX, DiffUploadSchema, E2eAreaMapSchema } from '../cards/lean-v6.ts';
import { DiffStats, StoredCompletionAction } from '../cards/types.ts';
import { CeoShiftSchema } from '../ceo/ipc.ts';
import { CeoOrderSpecSchema, ToolCountsSchema } from '../ceo/turns.ts';
import {
  AccountKeySchema,
  ClaudeAccountEnsurePayloadSchema,
  ClaudeAccountInfoSchema,
} from '../claude/accounts.ts';
import {
  DeployConnectPayloadSchema,
  DeployKeyPayloadSchema,
  DeployPreparePayloadSchema,
  DeployRevokePayloadSchema,
  HostKeyScanPayloadSchema,
} from '../delivery/connect.ts';
import { DeployMovePayloadSchema } from '../delivery/move.ts';
import { DeployProbePayloadSchema } from '../delivery/probe.ts';
import {
  DeployExecPayloadSchema,
  DeploySecretSetPayloadSchema,
  RecipeInspectPayloadSchema,
  RecipeWritePayloadSchema,
} from '../delivery/protocol.ts';
import {
  EnvEnsurePayloadSchema,
  RepoClonePayloadSchema,
  RightsVerifyPayloadSchema,
  SudoKeySchema,
  SudoSetPayloadSchema,
} from '../devops/environment.ts';
import { DevopsShiftSchema } from '../devops/index.ts';
import { Usage } from '../events/define.ts';
import { GuardViolation, ShiftKind } from '../events/shift.ts';
import { TestEnvProblem } from '../events/testing.ts';
import { VaultEventKind } from '../events/vault.ts';
import { OutboundPostPayloadSchema } from '../external/index.ts';
import { FeedItemInputSchema } from '../feed/index.ts';
import {
  ForgeKindSchema,
  ForgeReposPayloadSchema,
  GitConnectionsSchema,
  GitSshPayloadSchema,
  RepoAccessPayloadSchema,
} from '../forge/index.ts';
import {
  GraphIndexPayloadSchema,
  GraphOrgPayloadSchema,
  OrgGraphScopeSchema,
  ShiftContextMetricsSchema,
} from '../graph/index.ts';
import { SWEEP_QUERY_MAX_PATHS, WorktreesSweepPayloadSchema } from '../hygiene/index.ts';
import { PROTOCOL_VERSION, uuidv7 } from '../ids.ts';
import { IntakeContextSchema, QuestionShiftSchema } from '../intake/index.ts';
import {
  IntegrationBeginPayloadSchema,
  IntegrationCancelPayloadSchema,
  IntegrationConnectPayloadSchema,
  IntegrationInputPayloadSchema,
  IntegrationRequestPayloadSchema,
  IntegrationSessionMsgSchema,
  IntegrationStatusSchema,
  IntegrationsPolicySchema,
  MAX_INTEGRATION_STATUSES,
} from '../integrations/schema.ts';
import { MAX_MCP_SERVERS, McpServerInfoSchema } from '../mcp/index.ts';
import {
  ProviderKeyResealPayloadSchema,
  ReportedBackendSchema,
  ReportedKeySchema,
  ReportedModelSchema,
} from '../models/credentials.ts';
import {
  ProviderKeyClearPayloadSchema,
  ProviderKeySetPayloadSchema,
  ReportedProviderSchema,
} from '../models/direct.ts';
import { BaTaskShiftSchema, BranchCheckMergedPayloadSchema } from '../phases/index.ts';
import { CommitAsSchema, RepoCreatePayloadSchema, RepoIdentityFactSchema } from '../repo/index.ts';
import { AgentPermissionsSchema, Seniority } from '../roles/schema.ts';
import {
  EnvSecretClearPayloadSchema,
  EnvSecretSetPayloadSchema,
  ShiftEnvironmentSchema,
} from '../runs/integration.ts';
import {
  RunExtendPayloadSchema,
  RunLogLinesSchema,
  RunPlanSavedMsgSchema,
  RunReplayFailedMsgSchema,
  RunRestartPayloadSchema,
  RunStartPayloadSchema,
  RunStatusSchema,
  RunStopPayloadSchema,
} from '../runs/types.ts';
import { VaultFolderSchema } from '../safe.ts';
import { SessionTurnSpecSchema } from '../sessions/index.ts';
import { FinalizeExecutePayloadSchema } from '../testing/index.ts';
import {
  VaultConfigureCommandSchema,
  VaultIdSchema,
  VaultMergeCommandSchema,
  VaultMoveCommandSchema,
  VaultWriteCommandSchema,
} from '../vaults/index.ts';
import { LedgerMatchSchema, RpcMethodSchema, ShiftReportSchema } from './ipc.ts';

/**
 * Runner WebSocket protocol (docs/ARCHITECTURE.md section 11.2).
 * Endpoint `wss://<host>/api/runner/ws`, header `Authorization: Bearer aomr_...`, subprotocol `aom.runner.v1`.
 * Every frame is a JSON text envelope `{ v:1, id, type, ts, ...payload }` with the payload fields inline.
 */

export const RUNNER_SUBPROTOCOL = 'aom.runner.v1';
export const RUNNER_TOKEN_PREFIX = 'aomr_';
export const WS_CLOSE = { unauthorized: 4401, forbidden: 4403, superseded: 4409 } as const;
/** The close reason of a 4403 sent because the workstation was unpaired in the web app: the runner then stops cleanly. */
export const UNPAIRED_CLOSE_REASON = 'workstation unpaired';
export const HEARTBEAT_SEC = 15;

const msg = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().min(1),
    type: z.literal(type),
    ts: z.iso.datetime(),
    ...shape,
  });

// ---------------------------------------------------------------- shared shapes

/**
 * Is an OS-level boundary around the agent's shell in force? `enforced`: yes. `unsandboxed`: no, and the owner opted
 * in (config `off`, or `best_effort` + `allowUnsandboxed`). `unavailable`: no, and the runtime refuses to run agents.
 */
export const SandboxStateSchema = z.enum(['enforced', 'unsandboxed', 'unavailable']);
export type SandboxState = z.infer<typeof SandboxStateSchema>;

export const RuntimeInfoSchema = z.object({
  id: z.string(),
  version: z.string(),
  available: z.boolean(),
  capabilities: z.array(z.string()),
  /** Absent from older runners and from runtimes without a sandbox concept: no warning is shown then. */
  sandbox: SandboxStateSchema.optional(),
  sandboxReason: z.string().optional(),
  /**
   * The runtime's login: `expired` when its sign-in no longer works (Claude Code: "OAuth session expired"); such a
   * runtime is also reported `available: false` so nothing is dispatched to it. Absent from older runners.
   */
  auth: z.enum(['ok', 'expired']).optional(),
  /**
   * The runtime's model usage limit (Claude subscription session/weekly limit): `limited` until `limitedUntil`; such a
   * runtime is also reported `available: false`. `limitedLabel` is that time in the workstation's own zone ("18:00
   * (Africa/Johannesburg)") for notices. Absent from older runners and while no limit is in force.
   */
  usage: z.enum(['ok', 'limited']).optional(),
  limitedUntil: z.iso.datetime().optional(),
  limitedLabel: z.string().max(100).optional(),
  /**
   * Claude Code only: every account on the workstation (main and additional). When present the top-level `auth`,
   * `usage` and `limitedUntil` describe main, and `available` is false only when no account is usable.
   */
  accounts: z.array(ClaudeAccountInfoSchema).max(20).optional(),
  /**
   * Direct-model only: the providers whose key (or endpoint) is stored on this workstation, with the models each offers.
   * Names only, never a key. Absent from older runners and from other runtimes: no direct models are offered then.
   */
  providers: z.array(ReportedProviderSchema).max(10).optional(),
  /**
   * Direct-model runtime: every provider key or credential stored here and whose it is (workstation key over organization key).
   * Facts for the server's key resolution and spend caps; never a key. Absent from older runners.
   */
  keys: z.array(ReportedKeySchema).max(20).optional(),
  /** Claude Code: the backends (Bedrock, Vertex, a gateway) that have a credential on this workstation, with their models. */
  backends: z.array(ReportedBackendSchema).max(5).optional(),
  /** Gemini CLI and opencode: the models this workstation offers (the Gemini built-ins plus the owner's extras; opencode's own list). */
  models: z.array(ReportedModelSchema).max(400).optional(),
  /** Gemini CLI: whether the runtime signs in with the owner's Google login or spends the stored `google` key. */
  authVia: z.enum(['login', 'key']).optional(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

export const RepoReportSchema = z.object({
  remoteUrl: z.string(),
  localPath: z.string(),
  headBranch: z.string().nullable(),
  /** The git identity commits get in this clone without a project setting (repository, global or system git config); absent: none set. Additive. */
  identity: RepoIdentityFactSchema.nullable().optional(),
});
export type RepoReport = z.infer<typeof RepoReportSchema>;

/**
 * A repository found on the workstation under a repoRoot, for the "reference repositories" picker: any clone, with or
 * without a remote. Never an absolute path: `localKey` is the path relative to the repoRoot it was found under (forward
 * slashes), the stable identifier of a repository without a remote.
 */
export const CatalogRepoSchema = z.object({
  name: z.string().max(200),
  localKey: z.string().max(500),
  remoteUrlNormalized: z.string().max(500).nullable(),
});
export type CatalogRepo = z.infer<typeof CatalogRepoSchema>;

export const AgentRuntimeSpecSchema = z.object({
  agentId: z.uuid(),
  name: z.string(),
  roleKey: z.string(),
  seniority: Seniority,
  runtime: z.string(),
  model: z.string(),
  effort: z.string().optional(),
  skills: z.array(z.string()),
  permissions: AgentPermissionsSchema,
  isDevops: z.boolean(),
});
export type AgentRuntimeSpec = z.infer<typeof AgentRuntimeSpecSchema>;

export const WorktreeSpecSchema = z.object({
  /**
   * `readonly`: no card branch exists yet (the card's dependencies have not landed); the runner opens a detached,
   * read-only checkout of `baseBranch` for the architect to read and removes it after the shift.
   */
  mode: z.enum(['create', 'reuse', 'readonly']),
  repoId: z.uuid(),
  remoteUrlNormalized: z.string(),
  baseBranch: z.string(),
  branchName: z.string(),
  /** Set for `reuse`. */
  path: z.string().optional(),
  /** The repository's main branch: a missing working branch is created from it (absent: the default branch). */
  mainBranch: z.string().optional(),
});
export type WorktreeSpec = z.infer<typeof WorktreeSpecSchema>;

export const ShiftBriefSchema = z.object({
  shift: z.object({
    id: z.uuid(),
    kind: ShiftKind,
    stage: z.string(),
    stageLabel: z.string(),
    doneCriteria: z.string(),
    outcomes: z.array(
      z.object({ id: z.string(), label: z.string(), kind: z.enum(['success', 'failure']), data: z.string() }),
    ),
    maxShiftMinutes: z.number().int().positive(),
  }),
  /** Contract addition: who is being briefed (the instructions open with this). */
  agent: z.object({ id: z.uuid(), name: z.string(), seniority: Seniority }),
  card: z.object({
    id: z.uuid(),
    ref: z.string(),
    title: z.string(),
    cardType: z.string(),
    fields: z.record(z.string(), z.unknown()),
    riskTier: z.enum(['small', 'large']).nullable(),
    reworkRound: z.number().int().nonnegative(),
    completionAction: StoredCompletionAction.nullable(),
    docsNeeded: z.boolean(),
    /** Run the Investigate & design stage before build (absent: older servers). */
    designNeeded: z.boolean().optional(),
    /** The card only investigates: investigate -> finalize, no build. */
    investigationOnly: z.boolean().optional(),
    dependencies: z.array(
      z.object({
        ref: z.string(),
        title: z.string(),
        status: z.string(),
        /** The dependency's work is in the working branch (merged at Finalize, or done): it counts as satisfied. */
        landed: z.boolean().optional(),
      }),
    ),
    /** Files attached to the card: the runner copies them into a read-only folder next to the shift. */
    attachments: z.array(BriefAttachmentSchema).optional(),
    parent: z.object({ ref: z.string(), title: z.string() }).optional(),
    /**
     * The card was made from an inbound e-mail (docs/design/workflow-builder.md D9): these fields (and the title) hold
     * text from an outside sender and are rendered inside an untrusted block, never as instructions.
     */
    untrusted: z
      .object({
        source: z.literal('email'),
        /** `webhook`: the text came from an incoming webhook, not an e-mail (older runners still say "e-mail"). */
        kind: z.enum(['email', 'webhook']).optional(),
        fields: z.array(z.string()),
        title: z.boolean().default(true),
        from: z.string().optional(),
      })
      .optional(),
  }),
  project: z.object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    /** Legacy (ignored): the server no longer sends it. */
    domain: z.enum(['work', 'personal']).optional(),
    workingBranch: z.string(),
    e2eGlobs: z.array(z.string()),
    architecturalGlobs: z.array(z.string()),
    vaultFolder: z.string().optional(),
    /** The sub directory of the card's repository the project lives in; absent: the repository root. */
    projectPath: z.string().optional(),
    /** M3: `PROJECT.md` from the card's vault, filled in by the runner (the site holds no vault content). */
    projectDoc: z.string().optional(),
  }),
  role: z.object({
    key: z.string(),
    name: z.string(),
    instructions: z.string(),
    coreRules: z.array(z.string()),
    extensions: z.string().optional(),
    skills: z.array(z.string()),
  }),
  /**
   * Investigate & design (docs/design/architect-and-workflows.md): where the architect writes its report and, once it
   * was recorded, what the next stages read. Absent on cards that never investigate.
   */
  investigation: z
    .object({
      /** `repo`: a path inside the worktree; `vault`: a file name (the runner writes it into the project vault). */
      reportPath: z.string(),
      location: z.enum(['repo', 'vault']),
      /** The folder the architect may write documents in (`repo`); the runner adds it to the writable globs. */
      folder: z.string().optional(),
      investigationOnly: z.boolean(),
      /** Set when the vault was asked for but the project has none: the report goes in the repository (one line for the prompt). */
      note: z.string().optional(),
      /** Merge the latest main branch first applies to this card (the architect resolves a conflict). */
      mergeMainFirst: z.boolean().default(false),
      /**
       * Designing before the card's dependencies have landed: the shift has no card branch, only a read-only checkout of
       * the working branch. The report is written in the scratch directory; the runner saves it in the vault, or hands
       * its text to the server (`deferred`), and the builder commits it on the card branch.
       */
      readOnly: z.boolean().optional(),
      /**
       * The assumption-review shift (the dependencies landed since the design was made): check each recorded assumption
       * against the landed code, then `aom design confirm` or `aom design revise`.
       */
      review: z
        .object({
          assumptions: z.array(
            z.object({ assumption: z.string(), dependency: z.string(), ifWrong: z.string() }),
          ),
          dependencies: z.array(z.string()),
        })
        .optional(),
      /** With `readOnly`: the dependencies that are not in the working branch yet, with what is known of their design. */
      unlandedDependencies: z
        .array(
          z.object({
            ref: z.string(),
            title: z.string(),
            status: z.string(),
            spec: z.string().optional(),
            report: z
              .object({
                reportPath: z.string(),
                location: z.enum(['repo', 'vault']),
                summary: z.string(),
                body: z.string().optional(),
              })
              .optional(),
          }),
        )
        .optional(),
      /** The report that was recorded by the investigate stage (later stages read it). */
      report: z
        .object({
          reportPath: z.string(),
          location: z.enum(['repo', 'vault']),
          summary: z.string(),
          commit: z.string().optional(),
          /** A repository report written before the card branch existed: the builder commits this text at `reportPath`. */
          body: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * The reviewer's risk call on this card (backlog #70): given to the stages that test it (test, qa_steps) so they
   * look at the risky areas first.
   */
  reviewRisk: z
    .object({
      level: z.enum(['low', 'medium', 'high', 'unknown']),
      analysis: z.string(),
      qaFocus: z.string(),
    })
    .optional(),
  /** All handoffs, oldest first. */
  handoffs: z.array(
    z.object({
      stage: z.string(),
      agentName: z.string(),
      outcome: z.string(),
      note: z.string(),
      at: z.iso.datetime(),
    }),
  ),
  /** Latest rework round. */
  reviewComments: z.array(
    z.object({
      reviewerName: z.string(),
      reasons: z.array(z.string()),
      criteriaMissed: z.array(z.string()),
      comments: z.string(),
      at: z.iso.datetime(),
    }),
  ),
  /** Last 30 thread messages. */
  thread: z.array(
    z.object({
      authorName: z.string(),
      kind: z.string(),
      body: z.string(),
      at: z.iso.datetime(),
      /** The message is e-mail text from an outside sender (rendered as untrusted content). */
      untrusted: z.boolean().optional(),
    }),
  ),
  /** Ledger standing orders (M2), org + project. */
  standingOrders: z.array(z.object({ title: z.string(), body: z.string() })).default([]),
  /** Ledger entries linked to the card. */
  ledger: z
    .array(z.object({ id: z.string(), scope: z.string(), title: z.string(), body: z.string() }))
    .default([]),
  /** How many entries the card has in all when `ledger` holds only the newest few (the prompt points at `aom ledger search`). */
  ledgerTotal: z.number().int().optional(),
  /**
   * M5: feed context for scouts and curators. `candidates` are the items the scout handed off (curator only),
   * `seenUrls` the project's seen-list (normalized), `taste` the project's `taste.md` (filled in by the runner from
   * the vault).
   */
  feed: z
    .object({
      candidates: z.array(FeedItemInputSchema).default([]),
      seenUrls: z.array(z.string()).default([]),
      taste: z.string().optional(),
      /** Explicit taste rules the manager set on the Interests page (project-wide plus this card's interest). */
      tasteSeed: z.array(z.string()).default([]),
    })
    .optional(),
  /**
   * The environment this shift tests against (a `test`-like stage with `environment: 'project'` and integration tests on
   * for the project). Absent: the shift has none (the tester follows the card's test plan as before).
   */
  environment: ShiftEnvironmentSchema.optional(),
  /**
   * The project's setting "test without an environment" is on and this is a tester shift: the runner does not require a
   * ready environment, and the tester records that none was used when there is none.
   */
  testWithoutEnvironment: z.boolean().optional(),
  /**
   * lean team, the Card Brief and the group: the short summary the planner or architect wrote for the builder, and the other
   * cards of the group (one builder works them in order, in one resumed session).
   */
  cardBrief: z.string().optional(),
  group: z
    .object({
      id: z.string(),
      cards: z.array(z.object({ ref: z.string(), title: z.string(), stage: z.string(), status: z.string() })),
    })
    .optional(),
  /** lean team, the planning shift: the other open cards of the project (to group and to order), newest first. */
  openCards: z
    .array(
      z.object({
        ref: z.string(),
        title: z.string(),
        stage: z.string(),
        groupId: z.string().optional(),
        affectedAreas: z.string().optional(),
      }),
    )
    .optional(),
  /** lean team: the build and unit test evidence of the card's handoff, bound to a commit (reviewers read it instead of building). */
  buildEvidence: z
    .object({
      sha: z.string(),
      commands: z.array(
        z.object({
          kind: z.string(),
          command: z.string(),
          status: z.string(),
          result: z.string(),
        }),
      ),
      waived: z.string().optional(),
      at: z.string(),
    })
    .optional(),
  /** lean team: the paths of the diff that make the change high risk (computed by the server, never lowered by an agent). */
  highRisk: z.object({ paths: z.array(z.string()), labels: z.array(z.string()) }).optional(),
  /** lean team, a merge review: the commit that was reviewed and the one DevOps resolved the conflict to. */
  mergeReview: z
    .object({
      oldHead: z.string().optional(),
      newHead: z.string().optional(),
      touched: z.array(z.string()).default([]),
    })
    .optional(),
  /**
   * lean team, a tester shift: the paths of the card diff and the project's E2E area mapping (absent: the default derived from
   * the E2E folders); the runner picks the specs that belong to the card.
   */
  e2e: z
    .object({
      changedPaths: z.array(z.string()),
      mapping: E2eAreaMapSchema.nullable(),
      hint: z.string().default(''),
    })
    .optional(),
});
export type ShiftBrief = z.infer<typeof ShiftBriefSchema>;

/**
 * A repository an agent may read (read-only) on this workstation, named by its remote: the runner resolves it to the
 * local clone. `project`: a repository of the chat's own project; `reference`: one of the project's reference repositories;
 * `org`: a repository of another project of the organization (agents whose role has `readOrgRepos`, the architect).
 */
export const ReadRepoSchema = z.object({
  repoId: z.uuid(),
  name: z.string(),
  remoteUrlNormalized: z.string(),
  kind: z.enum(['project', 'reference', 'org']),
});
export type ReadRepo = z.infer<typeof ReadRepoSchema>;

/**
 * A reference repository picked from a workstation's clones (not a project repository): `localKey` (present only when
 * sent to the workstation it was picked on) names the clone in that runner's catalog; `remoteUrlNormalized` (when the
 * repository has a remote) lets any workstation that has a clone of the same remote open it. A separate field from
 * `readRepos` so older runners ignore it.
 */
export const LocalReadRepoSchema = z.object({
  name: z.string(),
  localKey: z.string().optional(),
  remoteUrlNormalized: z.string().optional(),
});
export type LocalReadRepo = z.infer<typeof LocalReadRepoSchema>;

/** The one vault a card shift may read (docs/ARCHITECTURE.md section 16.1): its project vault, or the organization vault. */
export const ShiftVaultSchema = z.object({
  vaultId: VaultIdSchema,
  kind: VaultEventKind,
  /** `projects/<name>` inside the vault. */
  folder: VaultFolderSchema,
});
export type ShiftVault = z.infer<typeof ShiftVaultSchema>;

/**
 * The one vault a chat may read (read-only): the project's vault, or the organization vault. `folder` is absent for a chat
 * with no project (the organization vault as a whole). Knowledge never crosses organizations.
 */
export const ChatVaultSchema = ShiftVaultSchema.extend({ folder: VaultFolderSchema.optional() });
export type ChatVault = z.infer<typeof ChatVaultSchema>;

/**
 * Where the project's code graph is (docs/design/project-graphs.md section 7): the vault and folder the runner reads it
 * from, and the measurement arm. `off` is the holdout (section 11): no "Graph context" section and no `aom graph` verbs.
 */
export const GraphScopeSchema = z.object({
  vaultId: VaultIdSchema,
  /** `projects/<name>` inside the vault; the graph is in `<folder>/graph/`. */
  folder: VaultFolderSchema,
  arm: z.enum(['on', 'off']),
});
export type GraphScope = z.infer<typeof GraphScopeSchema>;

export const ChatContextSchema = z.object({
  /** The organization of the chat (the runner resolves the organization source folder with it). */
  orgId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  cardId: z.uuid().optional(),
  projectKey: z.string().optional(),
  cardRef: z.string().optional(),
  /** The ticket key the card in context was made from (`fields.externalRef`): the Jira attachments the chat may download. */
  cardExternalRef: z.string().optional(),
  /** Where the card's worktree lives on its home workstation (read-only context for the chat). */
  cardWorktreePath: z.string().optional(),
  /** Repositories the chat may read here: the project's own and its reference repositories (absent: none). */
  readRepos: z.array(ReadRepoSchema).optional(),
  /** Reference repositories picked from workstation clones (see `LocalReadRepoSchema`). */
  localReadRepos: z.array(LocalReadRepoSchema).optional(),
  /** M7: set for the BA's intake chat (project list, mapping state, cards created so far). */
  intake: IntakeContextSchema.optional(),
  /** Plugin MCP servers the project's Owner granted (names only; the runner holds the configuration). */
  mcpServers: z.array(z.string()).optional(),
  /** The knowledge vault this chat may read (read-only; absent: none for this workstation). */
  vault: ChatVaultSchema.optional(),
  /** The project's code graph for this conversation (read-only `aom graph` verbs). Absent: none. */
  graph: GraphScopeSchema.optional(),
  /** Set for the owner's chat with the CEO: persona, standing instructions, rules and the policy in words. */
  ceo: z.object({ brief: z.string() }).optional(),
  /** The owner's chat with the CEO: where the organization graph is (`aom ceo route`). Absent: none. */
  orgGraph: OrgGraphScopeSchema.optional(),
  /**
   * The standing orders that bind this conversation's agent: the organization's plus those of the project in
   * context (DevOps: every project of the organization). Additive; an older server sends none.
   */
  standingOrders: z.array(z.object({ title: z.string(), body: z.string() })).optional(),
});
export type ChatContext = z.infer<typeof ChatContextSchema>;

/**
 * `integration.run`: poll GitHub or Jira on the owner's workstation (the credentials never leave it). The answer is the
 * issues that match; the server takes the new ones into intake (docs/ARCHITECTURE.md section 10.4).
 */
export const IntegrationRunPayloadSchema = z.object({
  scheduleId: z.uuid(),
  /** The run waiting for the answer (an `issues_poll` action); absent for a labelled-issue trigger. */
  runId: z.uuid().optional(),
  integration: z.enum(['github', 'jira']),
  /** GitHub: `owner/repo`. Jira: a JQL filter. */
  query: z.string().min(1).max(500),
  /** Only issues with this label (a labelled-issue trigger). */
  label: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(100).default(30),
});
export type IntegrationRunPayload = z.infer<typeof IntegrationRunPayloadSchema>;

export const PolledIssueSchema = z.object({
  key: z.string().min(1).max(300),
  title: z.string().max(500),
  url: z.string().max(2000).optional(),
  body: z.string().max(20000).default(''),
  labels: z.array(z.string()).default([]),
});
export type PolledIssue = z.infer<typeof PolledIssueSchema>;

export const IntegrationRunResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(2000).optional(),
  issues: z.array(PolledIssueSchema).default([]),
});
export type IntegrationRunResult = z.infer<typeof IntegrationRunResultSchema>;

/**
 * `repo.open_pr`: open a pull request from a repository's working branch to its main branch (the project settings
 * button). `base` is the main branch the owner named; absent: the repository's default branch.
 */
export const RepoOpenPrPayloadSchema = z.object({
  requestId: z.uuid(),
  projectId: z.uuid(),
  repoId: z.uuid(),
  remoteUrlNormalized: z.string(),
  /** The working branch (the head of the pull request). */
  head: z.string().min(1),
  base: z.string().min(1).optional(),
  title: z.string().max(300),
  body: z.string().max(5000),
  forge: ForgeKindSchema.optional(),
});
export type RepoOpenPrPayload = z.infer<typeof RepoOpenPrPayloadSchema>;

export const RepoOpenPrResultSchema = z.object({
  ok: z.boolean(),
  /** The main branch the pull request goes to, as resolved on the workstation. */
  base: z.string().optional(),
  url: z.string().optional(),
  /** `ok` and no pull request: the working branch has nothing the main branch lacks, or it is the main branch. */
  nothingToDo: z.boolean().optional(),
  notice: z.string().optional(),
  error: z.string().optional(),
});
export type RepoOpenPrResult = z.infer<typeof RepoOpenPrResultSchema>;

/**
 * Organisation source folder (docs/RUNNER.md): the folder inside a repo root whose repositories the architect of one
 * organisation may read. `org.folder` sets (`path`) or clears (`path: null`) it; the runner validates exactly like
 * `aom-runner org-folder set` and answers `{ ok, error? }`. The state is reported in `org.folders`.
 */
export const OrgFolderCommandSchema = z.object({
  orgId: z.uuid(),
  path: z.string().trim().min(1).max(1000).nullable(),
});
export type OrgFolderCommand = z.infer<typeof OrgFolderCommandSchema>;
export const OrgFolderResultSchema = z.object({ ok: z.boolean(), error: z.string().max(600).optional() });
export type OrgFolderResult = z.infer<typeof OrgFolderResultSchema>;
/** One organisation's folder on one workstation, as the runner sees it now. */
export const OrgFolderStateSchema = z.object({
  orgId: z.uuid(),
  folder: z.string().max(1000),
  valid: z.boolean(),
  /** Why the folder cannot be opened (when `valid` is false). */
  reason: z.string().max(600).nullable(),
  /** Repositories the architect can read in it (0 when invalid). */
  repoCount: z.number().int().nonnegative(),
});
export type OrgFolderState = z.infer<typeof OrgFolderStateSchema>;
/** Upper bound of the folders the runner offers in the picker. */
export const MAX_ORG_FOLDER_CANDIDATES = 200;

/**
 * `repo.sync` ("Sync now"): fetch the repository's working branch and fast-forward it when that is safe (nothing is
 * forced and uncommitted work is never touched). The answer is a `RepoSyncStatus`; the runner also sends the same
 * facts as `repo.sync_status` after its periodic checks.
 */
export const RepoSyncPayloadSchema = z.object({
  repoId: z.uuid(),
  remoteUrlNormalized: z.string().min(1).max(500),
  workingBranch: z.string().min(1).max(200),
});
export type RepoSyncPayload = z.infer<typeof RepoSyncPayloadSchema>;
export const RepoSyncStateSchema = z.enum([
  'synced',
  'updated',
  'behind',
  'ahead',
  'diverged',
  'dirty',
  'busy',
  'no_remote',
  'missing_branch',
  'error',
]);
export type RepoSyncState = z.infer<typeof RepoSyncStateSchema>;
export const RepoSyncStatusSchema = z.object({
  /** The project repository (the server knows the workstation from the connection). */
  repoId: z.uuid(),
  workingBranch: z.string().max(200),
  state: RepoSyncStateSchema,
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  dirty: z.boolean(),
  onBranch: z.boolean(),
  checkedOutBranch: z.string().max(200).nullable(),
  detail: z.string().max(400).optional(),
  checkedAt: z.iso.datetime(),
});
export type RepoSyncStatus = z.infer<typeof RepoSyncStatusSchema>;

/**
 * What the workstation's owner chose for the shifts it runs at once (backlog #76): a number, `unlimited`, or null (none
 * chosen: the runner's own `maxConcurrentShifts` applies).
 */
export const ShiftLimitSettingSchema = z.union([
  z.number().int().min(1).max(10_000),
  z.literal('unlimited'),
  z.null(),
]);
export type ShiftLimitSetting = z.infer<typeof ShiftLimitSettingSchema>;
/** What the wire carries for "no limit": a count nobody reaches. UIs show a value at or above it as unlimited. */
export const UNLIMITED_SHIFTS = 100_000;
/** Announced in `hello.capabilities` by a runner that applies `limits.shiftLimit` and the `shifts.limit` command. */
export const SHIFT_LIMIT_CAPABILITY = 'shift-limit:1';
/**
 * Announced by a runner that can run the architect's design shift without a card branch (`worktree.mode: 'readonly'`:
 * a detached, read-only checkout of the working branch). The server offers an unlanded-dependency design only to these.
 */
export const READONLY_DESIGN_CAPABILITY = 'design-ro:1';

export const RunnerCommandNameSchema = z.enum([
  'agent.wipe',
  'worktree.remove',
  'repos.rescan',
  'vault.configure',
  'vault.write',
  'vault.move',
  'vault.merge',
  'finalize.execute',
  'outbound.post',
  'repo.create',
  'branch.check_merged',
  'worktrees.sweep',
  'integration.run',
  'repo.clone',
  'env.ensure',
  'rights.verify',
  'sudo.set',
  'sudo.clear',
  'env.secret.set',
  'env.secret.clear',
  'git.status',
  'forge.repos',
  'git.ssh',
  'repo.access',
  'repo.open_pr',
  'org.folder',
  'toolchain.remove',
  'repo.sync',
  'run.start',
  'run.stop',
  'run.extend',
  'run.restart',
  'integration.connect',
  'integration.begin',
  'integration.input',
  'integration.cancel',
  'integration.test',
  'integration.remove',
  'shifts.limit',
  'runner.pin',
  'runner.update.check',
  'graph.index',
  'graph.update',
  'graph.org',
  'recipe.inspect',
  'deploy.exec',
  'deploy.secret.set',
  'deploy.probe',
  'recipe.write',
  'deploy.hostkey',
  'deploy.key',
  'deploy.connect',
  'deploy.revoke',
  'deploy.prepare',
  'deploy.move',
  'claude.account.ensure',
  'provider.key.set',
  'provider.key.clear',
  'provider.key.reseal',
  'packs.sync',
  'pack.check',
]);
export type RunnerCommandName = z.infer<typeof RunnerCommandNameSchema>;

/** Typed payloads for the commands; `command.payload` is the loose record on the wire. */
export const CommandPayloadSchemas = {
  /** The full list of capability packs this workstation should hold (git, pinned commit, trust, scripts); see section 38.4. */
  'packs.sync': PacksSyncPayloadSchema,
  'pack.check': PackCheckPayloadSchema,
  'provider.key.set': ProviderKeySetPayloadSchema,
  'provider.key.clear': ProviderKeyClearPayloadSchema,
  'provider.key.reseal': ProviderKeyResealPayloadSchema,
  'claude.account.ensure': ClaudeAccountEnsurePayloadSchema,
  'vault.configure': VaultConfigureCommandSchema,
  'vault.write': VaultWriteCommandSchema,
  'vault.move': VaultMoveCommandSchema,
  'vault.merge': VaultMergeCommandSchema,
  'agent.wipe': z.object({ agentId: z.uuid() }),
  'worktree.remove': z.object({
    repoId: z.uuid().optional(),
    path: z.string(),
    branchName: z.string().optional(),
    deleteBranch: z.boolean().default(false),
  }),
  'repos.rescan': z.object({}),
  'finalize.execute': FinalizeExecutePayloadSchema,
  'outbound.post': OutboundPostPayloadSchema,
  'repo.create': RepoCreatePayloadSchema,
  'branch.check_merged': BranchCheckMergedPayloadSchema,
  'worktrees.sweep': WorktreesSweepPayloadSchema,
  'integration.run': IntegrationRunPayloadSchema,
  'repo.clone': RepoClonePayloadSchema,
  'env.ensure': EnvEnsurePayloadSchema,
  'rights.verify': RightsVerifyPayloadSchema,
  'sudo.set': SudoSetPayloadSchema,
  'sudo.clear': z.object({}),
  'env.secret.set': EnvSecretSetPayloadSchema,
  'env.secret.clear': EnvSecretClearPayloadSchema,
  'git.status': z.object({}),
  'forge.repos': ForgeReposPayloadSchema,
  'git.ssh': GitSshPayloadSchema,
  'repo.access': RepoAccessPayloadSchema,
  'repo.open_pr': RepoOpenPrPayloadSchema,
  'org.folder': OrgFolderCommandSchema,
  'toolchain.remove': z.object({ name: z.string().min(1).max(80) }),
  'repo.sync': RepoSyncPayloadSchema,
  'run.start': RunStartPayloadSchema,
  'run.stop': RunStopPayloadSchema,
  'run.extend': RunExtendPayloadSchema,
  'run.restart': RunRestartPayloadSchema,
  'integration.connect': IntegrationConnectPayloadSchema,
  'integration.begin': IntegrationBeginPayloadSchema,
  'integration.input': IntegrationInputPayloadSchema,
  'integration.cancel': IntegrationCancelPayloadSchema,
  'integration.test': IntegrationRequestPayloadSchema,
  'integration.remove': IntegrationRequestPayloadSchema,
  /** The owner changed the shift limit: apply `maxConcurrentShifts` live and remember it (see `WelcomeSchema`). */
  'shifts.limit': z.object({
    shiftLimit: ShiftLimitSettingSchema,
    maxConcurrentShifts: z.number().int().positive(),
  }),
  /**
   * Safe mode (platform team): run exactly this runner version (an older one too: a rollback), or null to follow the
   * latest release again. The same value rides on `welcome.runnerPin`; a runner without the `runner-pin:1` capability
   * ignores both.
   */
  'runner.pin': z.object({ version: z.string().max(40).nullable() }),
  /** "Check for updates" on the Workstations page: run the updater's check now instead of at the next timer. */
  'runner.update.check': z.object({}),
  /** Project graphs: index a repository into the project vault / bring the graph up to a merge commit (docs/design/project-graphs.md). */
  'graph.index': GraphIndexPayloadSchema,
  'graph.update': GraphIndexPayloadSchema,
  /** Build the organization graph into `org/graph/` of the organization vault (docs/design/project-graphs.md section 8). */
  'graph.org': GraphOrgPayloadSchema,
  /** Delivery recipes (docs/design/ceo-front-door.md section 9): inspect `delivery/` of a project vault, run an approved deploy, keep a sealed secret. */
  'recipe.inspect': RecipeInspectPayloadSchema,
  'deploy.exec': DeployExecPayloadSchema,
  'deploy.secret.set': DeploySecretSetPayloadSchema,
  /** Guided deploy setup (docs/design/deploy-run-ux-design.md): a read-only probe of Docker / a server, and writing the generated `delivery/` files. */
  'deploy.probe': DeployProbePayloadSchema,
  'recipe.write': RecipeWritePayloadSchema,
  /** Guided connect, dedicated deploy keys and server preparation (docs/design/deploy-run-ux-design.md v2). */
  'deploy.hostkey': HostKeyScanPayloadSchema,
  'deploy.key': DeployKeyPayloadSchema,
  'deploy.connect': DeployConnectPayloadSchema,
  'deploy.revoke': DeployRevokePayloadSchema,
  'deploy.prepare': DeployPreparePayloadSchema,
  /** Moving to a new server (design v3): one step of the move per command. */
  'deploy.move': DeployMovePayloadSchema,
} as const;

/** Announced in `hello.capabilities`-style lists by runners that apply a version pin (`runner.pin`, `welcome.runnerPin`). */
export const RUNNER_PIN_CAPABILITY = 'runner-pin:1';

/** Announced by runners that answer the `runner.update.check` command ("Check for updates" on the Workstations page). */
export const RUNNER_UPDATE_CHECK_CAPABILITY = 'update-check:1';

/**
 * The outcome of a `runner.update.check` (the command's result): `up_to_date`, `update_found` (`version` is downloaded or
 * downloading and installs when the runner is idle), `paused` (the platform kill switch), `disabled` (`AOM_RUNNER_AUTO_UPDATE=0`
 * or not an installer-managed install), `failed` (`detail` says why).
 */
export const RUNNER_UPDATE_CHECK_OUTCOMES = [
  'up_to_date',
  'update_found',
  'paused',
  'disabled',
  'failed',
] as const;
export const RunnerUpdateCheckResultSchema = z.object({
  outcome: z.enum(RUNNER_UPDATE_CHECK_OUTCOMES),
  version: z.string().max(40).nullable(),
  detail: z.string().max(300).nullable(),
});
export type RunnerUpdateCheckResult = z.infer<typeof RunnerUpdateCheckResultSchema>;

/** The commands that carry a sealed envelope: their payload is emptied once answered, and they expire. */
export const ENVELOPE_COMMANDS: ReadonlySet<string> = new Set([
  'integration.connect',
  'integration.input',
  'env.secret.set',
  'deploy.secret.set',
  'deploy.connect',
  'provider.key.set',
]);

export const ShiftRejectReasonSchema = z.enum([
  'busy',
  'runtime_unavailable',
  'repo_missing',
  'worktree_failed',
  'rebase_conflict',
  /** M4: a tester shift found the app not deployed or Docker missing (see `environment`). */
  'environment_not_ready',
  /** The runtime's login expired (Claude Code: "OAuth session expired"): the card goes back to the queue, no penalty. */
  'auth_expired',
  /** The model usage limit was hit (`limitedUntil` says when it resets): the card goes back to the queue, no penalty. */
  'usage_limited',
  'internal',
]);
export const ShiftStopReasonSchema = z.enum([
  'timeout',
  'claim_lost',
  'agent_retired',
  'manager',
  'card_cancelled',
]);
export const ProgressItemSchema = z.object({
  at: z.iso.datetime(),
  kind: z.enum(['text', 'tool', 'status']),
  text: z.string().max(500),
});
export type ProgressItem = z.infer<typeof ProgressItemSchema>;
export const RunnerShiftOutcomeSchema = z.enum(['reported', 'no_report', 'stopped', 'crashed', 'timeout']);

// ----------------------------------------------------------------- runner -> server

export const HelloSchema = msg('hello', {
  runnerVersion: z.string(),
  protocol: z.literal(PROTOCOL_VERSION),
  platform: z.string(),
  hostname: z.string(),
  runtimes: z.array(RuntimeInfoSchema),
  repos: z.array(RepoReportSchema),
  /** Every repository under the repoRoots (with or without a remote), for the reference repositories picker. Absent from older runners. */
  repoCatalog: z.array(CatalogRepoSchema).max(2000).optional(),
  vaults: z.array(z.object({ vaultId: z.string(), localPath: z.string(), clean: z.boolean() })).default([]),
  activeShifts: z.array(
    z.object({
      shiftId: z.uuid(),
      cardId: z.uuid().optional(),
      agentId: z.uuid(),
      startedAt: z.iso.datetime(),
    }),
  ),
  /** Chats (CEO owner and order turns among them) the runner is running right now: the server fails the turns it holds as running but are not listed. Absent from older runners. */
  activeChats: z.array(z.string()).optional(),
  outboxPending: z.number().int().nonnegative(),
  /** The runner's configured `maxConcurrentShifts` (shown on the Workstations page; the server caps it). */
  maxConcurrentShifts: z.number().int().positive().optional(),
  /** The key the manager's browser encrypts the sudo password with (the private half never leaves the runner). */
  sudoKey: SudoKeySchema.optional(),
  /** Features this runner has (additive): `runs:1` = it can run a branch (`run.start`); the web app hides the buttons otherwise. */
  capabilities: z.array(z.string().max(40)).max(50).optional(),
  /** The runner's cap on run environments held at once (default 2 when absent). */
  maxRunEnvironments: z.number().int().positive().optional(),
  /** The runner supports connecting integrations from the web (docs/design/integrations-page.md). Absent from older runners. */
  integrationsVersion: z.number().int().positive().optional(),
});
export const OutboxFlushedSchema = msg('outbox.flushed', {});
export const HeartbeatSchema = msg('heartbeat', {
  activeShifts: z.array(z.string()),
  load: z.object({ runningShifts: z.number().int().nonnegative() }),
});
/** The runtimes' probe result changed (sandbox state, availability): sent after a re-probe, not only in `hello`. */
export const RuntimesReportSchema = msg('runtimes.report', { runtimes: z.array(RuntimeInfoSchema) });
/**
 * Which git providers this workstation is connected to (facts only, never a token). Sent after `hello`, after
 * `aom-runner git-connect` and on the `git.status` command.
 */
export const GitReportSchema = msg('git.report', { connections: GitConnectionsSchema });
/**
 * Jira on this workstation (docs/RUNNER.md "Jira on the runner"): facts only, never the token. `connected`: the saved
 * credentials were accepted; `refused`: Jira said no (wrong or expired token); `not_connected`: none saved.
 */
export const JiraStatusSchema = z.object({
  state: z.enum(['connected', 'not_connected', 'refused']),
  baseUrl: z.string().max(300).optional(),
  /** The Jira user the credentials belong to (display name), when connected. */
  account: z.string().max(200).optional(),
  detail: z.string().max(300).optional(),
});
export type JiraStatus = z.infer<typeof JiraStatusSchema>;
/** Sent after `welcome`, after `aom-runner jira-connect` and on the `git.status` command. */
export const JiraReportSchema = msg('jira.report', { status: JiraStatusSchema });
/**
 * Every integration of this workstation as one fact record each (docs/design/integrations-page.md). Sent after `welcome`,
 * after a connect, remove or test, after a recheck marker and on the re-scan when something changed. The legacy
 * `git.report`, `jira.report`, `mcp.servers` and `runtimes.report` continue unchanged.
 */
export const IntegrationsReportSchema = msg('integrations.report', {
  integrations: z.array(IntegrationStatusSchema).max(MAX_INTEGRATION_STATUSES),
  registryVersion: z.number().int().nonnegative(),
  policy: IntegrationsPolicySchema.optional(),
});
/** Progress of an interactive sign-in (URL, device code, paste step, result). Acked: a terminal state must not be lost. */
export const IntegrationSessionSchema = msg('integration.session', IntegrationSessionMsgSchema.shape);
/**
 * The organisation source folders set on this workstation and the folders it offers as candidates (absolute paths,
 * sub folders of the repo roots, bounded). Sent after `welcome`, after every re-scan and after `org.folder`.
 */
export const OrgFoldersReportSchema = msg('org.folders', {
  folders: z.array(OrgFolderStateSchema).max(100),
  candidates: z.array(z.string().max(1000)).max(MAX_ORG_FOLDER_CANDIDATES),
});
/**
 * The MCP servers of the installed, enabled Claude Code plugins of this workstation (names, plugin, transport; never an
 * environment value, header, token or argument). Sent after `welcome` and after every re-scan that changed them.
 */
export const McpServersReportSchema = msg('mcp.servers', {
  servers: z.array(McpServerInfoSchema).max(MAX_MCP_SERVERS),
});
/**
 * One agent toolchain of the workstation (docs/RUNNER.md "Agent toolchains"): a tool sandboxed agents may use. Detected
 * ones and the ones the DevOps engineer registered are listed; only registered ones can be removed. Folder paths and
 * the names of the variables it sets, never a value.
 */
export const ToolchainInfoSchema = z.object({
  name: z.string().min(1).max(80),
  source: z.enum(['detected', 'devops', 'config']),
  version: z.string().max(200).optional(),
  binDirs: z.array(z.string().max(1000)).max(8),
  readDirs: z.array(z.string().max(1000)).max(16),
  envKeys: z.array(z.string().max(80)).max(16),
  addedAt: z.string().max(40).optional(),
  addedBy: z.enum(['devops', 'owner']).optional(),
});
export type ToolchainInfo = z.infer<typeof ToolchainInfoSchema>;
export const MAX_TOOLCHAINS = 64;
/** Sent after `welcome`, after every re-scan that changed them and after `aom toolchain add|remove`. */
export const ToolchainsReportSchema = msg('toolchains.report', {
  toolchains: z.array(ToolchainInfoSchema).max(MAX_TOOLCHAINS),
});
/** Announced in `hello.capabilities` by runners that execute session turns (`chat.start.session`). */
export const SESSION_TURNS_CAPABILITY = 'session-turns:1';
/** Announced in `welcome.features` by servers that accept `capabilities.report`. */
export const CAPABILITY_REGISTRY_FEATURE = 'capability-registry:1';
export const MAX_CAPABILITY_ITEMS = 500;
/**
 * The organization vault's capabilities (`org/skills`, `org/personas`, `org/playbooks`) as this runner indexed them:
 * metadata only. A full snapshot, sent after a vault sync that changed them (and after `welcome`).
 */
export const CapabilitiesReportSchema = msg('capabilities.report', {
  vaultId: VaultIdSchema,
  items: z.array(CapabilityMetaSchema.extend({ source: z.literal('org-vault') })).max(MAX_CAPABILITY_ITEMS),
  issues: z
    .array(z.object({ path: z.string().max(300), message: z.string().max(500) }))
    .max(100)
    .default([]),
});
/** A pack's state on this workstation (cloned, indexed, update found, failed, or its files no longer match the approved hash). */
export const PacksReportMsgSchema = msg('packs.report', PacksReportSchema.shape);
/** The capabilities found in a project's checkout (`.agents/skills`, `.claude/skills`, `.claude/agents`). */
export const ProjectCapabilitiesReportMsgSchema = msg(
  'capabilities.project.report',
  ProjectCapabilitiesReportSchema.shape,
);
/** How a runner's self-update stands (docs/RUNNER.md "Updates"). */
export const RUNNER_UPDATE_STATES = [
  'up_to_date',
  'pending',
  'updating',
  'failed',
  'rolled_back',
  'paused',
  'unmanaged',
] as const;
export const RunnerUpdateStateSchema = z.enum(RUNNER_UPDATE_STATES);
export type RunnerUpdateState = z.infer<typeof RunnerUpdateStateSchema>;
/**
 * The runner's update state, sent after `welcome` and whenever it changes: `pending` a newer version is downloaded and
 * waits for the runner to be idle, `updating` it is switching and restarting, `failed` the last attempt failed,
 * `rolled_back` a new version did not connect and the previous one was restored, `paused` a super admin paused
 * auto-updates, `unmanaged` this install cannot update itself (started by hand, not from the installer's layout).
 */
export const RunnerUpdateReportSchema = msg('runner.update', {
  state: RunnerUpdateStateSchema,
  latestVersion: z.string().max(40).nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  detail: z.string().max(300).nullable(),
});
export const ReposReportSchema = msg('repos.report', {
  repos: z.array(RepoReportSchema),
  repoCatalog: z.array(CatalogRepoSchema).max(2000).optional(),
});
export const ShiftAcceptedSchema = msg('shift.accepted', { shiftId: z.uuid() });
export const ShiftRejectedSchema = msg('shift.rejected', {
  shiftId: z.uuid(),
  reason: ShiftRejectReasonSchema,
  detail: z.string().optional(),
  /** Set with `reason: 'usage_limited'`: when the usage limit resets (ISO); `detail` is that time as the workstation reads it. */
  limitedUntil: z.iso.datetime().optional(),
  /** With reason usage_limited | auth_expired | runtime_unavailable (account_missing): the account concerned. */
  accountKey: AccountKeySchema.optional(),
  conflictedFiles: z.array(z.string()).optional(),
  /** Set with `reason: 'environment_not_ready'`. */
  environment: z.object({ problem: TestEnvProblem, detail: z.string().optional() }).optional(),
  /** Set with `reason: 'worktree_failed'` when the card's base (working) branch does not exist in the clone. */
  branchProblem: z
    .object({
      base: z.string(),
      /** `origin/HEAD` of the clone, or its only branch. */
      defaultBranch: z.string().optional(),
      branches: z.array(z.string()).max(200),
      /** Why creating the branch from the default branch did not work (the runner tries first). */
      createFailed: z.string().max(500).optional(),
    })
    .optional(),
});
export const ShiftStartedSchema = msg('shift.started', {
  shiftId: z.uuid(),
  runtimeSessionId: z.string().optional(),
  worktree: z
    .object({
      path: z.string(),
      branchName: z.string(),
      baseBranch: z.string(),
      created: z.boolean(),
      headSha: z.string(),
      /** lean team: the runner rebased (or merged) the card branch onto its base before the shift; the commit moved with it. */
      rebased: z.boolean().optional(),
    })
    .optional(),
  /** The working branch did not exist: the runner created it from `from` (the default branch) and pushed it. */
  branchCreated: z
    .object({
      base: z.string(),
      from: z.string(),
      pushed: z.boolean(),
      /** The project's main branch was set explicitly (false: `from` is the host's default, which the runner looked up). */
      mainBranchSet: z.boolean().optional(),
    })
    .optional(),
  /** The branches origin has, as of the fetch for this shift (agent branches left out; absent: not known). */
  originBranches: z.array(z.string()).max(200).optional(),
  /** What the "merge latest main first" step did (absent: it did not run). */
  syncMain: z
    .object({
      result: z.enum(['merged_into_working', 'merged_into_card', 'conflict_in_card', 'skipped_conflict']),
      commit: z.string().optional(),
      files: z.array(z.string()).optional(),
    })
    .optional(),
});
/** What the runner did with the `resumeSessionId` of a `shift.start`. */
export const RESUME_STATES = [
  'resumed',
  'fresh_unknown_session',
  'fresh_too_large',
  'fresh_too_old',
  'fresh_other_agent',
  'fresh_transcript_missing',
  'fresh_other_account',
] as const;
export const ResumeStateSchema = z.enum(RESUME_STATES);
export type ResumeState = z.infer<typeof ResumeStateSchema>;
/**
 * Claude's session id arrives after `shift.started` (it is in the first stream line, after the process starts): sent as
 * a late update, again with the context size now and then. `resume` is set once, with the first update of a shift that
 * was asked to resume a session.
 */
export const ShiftSessionSchema = msg('shift.session', {
  shiftId: z.uuid(),
  runtimeSessionId: z.string().min(1).max(200),
  contextTokens: z.number().int().nonnegative().optional(),
  resume: z.object({ state: ResumeStateSchema, detail: z.string().max(300).optional() }).optional(),
});
/**
 * An unhandled error in the runner (`uncaughtException`, `unhandledRejection`, a failed self-check). Sanitised on the
 * runner: no prompts, card text or client code, only the error, a stack with paths shortened, the version and a short
 * context label. The server dedupes by `signature` and counts.
 */
export const RunnerErrorSchema = msg('runner.error', {
  signature: z.string().min(1).max(200),
  message: z.string().max(1000),
  stack: z.string().max(6000).optional(),
  version: z.string().max(40),
  context: z.string().max(200).optional(),
});
/** One DevOps shell command seen by the guard hook (allowed or refused); batched. */
export const DevopsAuditEntrySchema = z.object({
  at: z.iso.datetime(),
  /** The DevOps shift or chat the command ran in. */
  sessionRef: z.string().max(100),
  kind: z.enum(['shift', 'chat']),
  decision: z.enum(['allowed', 'refused']),
  /** The rule that refused it, or the class an allowed command fell in. */
  rule: z.string().max(80),
  command: z.string().max(2000),
});
export type DevopsAuditEntry = z.infer<typeof DevopsAuditEntrySchema>;
export const DevopsAuditSchema = msg('devops.audit', { entries: z.array(DevopsAuditEntrySchema).max(200) });
/**
 * Result of the role smoke test (runner start and after an update): per enabled role, whether its handoff command path
 * works in its real sandbox. A failed role gets no work on this workstation until a later run passes.
 */
export const RoleSmokeSchema = msg('role.smoke', {
  runnerVersion: z.string().max(40),
  results: z
    .array(
      z.object({
        roleKey: z.string().max(80),
        ok: z.boolean(),
        detail: z.string().max(500).optional(),
      }),
    )
    .max(100),
});
export const ShiftProgressSchema = msg('shift.progress', {
  shiftId: z.uuid(),
  items: z.array(ProgressItemSchema),
});
/** `report` for a terminal outcome from a build stage also carries runner-attached `diffStats` and `riskTier`. */
export const ShiftReportMsgSchema = msg('shift.report', {
  shiftId: z.uuid(),
  reportId: z.uuid(),
  report: ShiftReportSchema,
  diffStats: DiffStats.optional(),
  riskTier: z.enum(['small', 'large']).optional(),
  /**
   * lean team, a build handoff: the commit the runner measured after the shift's autocommit (the build evidence is bound to
   * it), the paths of the card diff (the server computes the high-risk flag from them) and the diff itself, capped at 2 MB.
   * Additive: an older runner sends none.
   */
  headSha: z.string().min(7).max(64).optional(),
  changedPaths: z.array(z.string().max(500)).max(CHANGED_PATHS_MAX).optional(),
  diff: DiffUploadSchema.optional(),
});
export const ShiftEndedSchema = msg('shift.ended', {
  shiftId: z.uuid(),
  outcome: RunnerShiftOutcomeSchema,
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative(),
  usage: Usage,
  /** Additive: the session's context size at the end (last call's input + cache read + cache write). */
  contextTokens: z.number().int().nonnegative().optional(),
  finalText: z.string().max(4000).optional(),
  guardViolations: z.array(GuardViolation).default([]),
  /** Additive: how the shift found its way in the code (docs/design/project-graphs.md section 11); numbers only. */
  context: ShiftContextMetricsSchema.optional(),
});
export const RpcRequestSchema = msg('rpc.request', {
  rpcId: z.string().min(1),
  shiftId: z.uuid(),
  method: RpcMethodSchema,
  params: z.record(z.string(), z.unknown()),
});
/**
 * The runner's sweep of stale worktrees (start-up and the hygiene job) asks which of the card worktrees it found are
 * still in use. Answered by `worktrees.live`; a runner that gets no answer sweeps nothing.
 */
export const WorktreesQuerySchema = msg('worktrees.query', {
  queryId: z.string().min(1),
  paths: z.array(z.string()).max(SWEEP_QUERY_MAX_PATHS),
});
/** A run environment changed (state, services, commit); also sent for every known environment after `welcome`. Not acked. */
export const RunStatusMsgSchema = msg('run.status', RunStatusSchema.shape);
/** Log lines of a run environment, only while a browser follows (`run.follow`). Not acked. */
export const RunLogMsgSchema = msg('run.log', RunLogLinesSchema.shape);
/** `aom run ready` saved the steps and services that worked as the project's run plan on this workstation. Acked. */
export const RunPlanSavedMsgSchemaWire = msg('run.plan.saved', RunPlanSavedMsgSchema.shape);
/** The saved plan failed or is out of date: the server files a DevOps `run` request to repair it. Acked. */
export const RunReplayFailedMsgSchemaWire = msg('run.replay.failed', RunReplayFailedMsgSchema.shape);
/** Max text of one `text` segment (characters). */
export const CHAT_SEGMENT_TEXT_MAX = 64_000;
/** Max segments of one turn; over it, `capChatSegments` keeps the first 50 and the last 249 with a `…` between. */
export const CHAT_SEGMENTS_MAX = 300;
/** Max text of a whole turn (characters, all text segments together); over it the middle is elided. */
export const CHAT_TURN_TEXT_MAX = 512_000;
/**
 * One step of an agent's turn, in order (docs/ARCHITECTURE.md, chat section): an assistant text block, a tool call
 * (`refused` = the permission mode denied it) or a thinking block (its content is never shown or sent).
 */
export const ChatSegmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(CHAT_SEGMENT_TEXT_MAX) }),
  z.object({
    type: z.literal('tool'),
    id: z.string().max(200).optional(),
    name: z.string().max(200),
    summary: z.string().max(500).optional(),
    status: z.enum(['running', 'ok', 'error', 'refused']),
  }),
  z.object({ type: z.literal('thinking') }),
]);
export type ChatSegment = z.infer<typeof ChatSegmentSchema>;

/**
 * Bounds a turn's segments: text segments cut to the limit, over `CHAT_SEGMENTS_MAX` segments the middle is elided, and
 * over `CHAT_TURN_TEXT_MAX` characters of text in total the middle is elided too (the head and tail keep half each).
 */
export function capChatSegments(segments: readonly ChatSegment[]): ChatSegment[] {
  const clipped = segments.map((s) =>
    s.type === 'text' && s.text.length > CHAT_SEGMENT_TEXT_MAX
      ? { ...s, text: s.text.slice(0, CHAT_SEGMENT_TEXT_MAX) }
      : s,
  );
  const bounded: ChatSegment[] =
    clipped.length <= CHAT_SEGMENTS_MAX
      ? clipped
      : [...clipped.slice(0, 50), { type: 'text', text: '…' }, ...clipped.slice(-(CHAT_SEGMENTS_MAX - 51))];
  const size = (s: ChatSegment) => (s.type === 'text' ? s.text.length : 0);
  if (bounded.reduce((n, s) => n + size(s), 0) <= CHAT_TURN_TEXT_MAX) return bounded;
  const half = CHAT_TURN_TEXT_MAX / 2;
  let head = 0;
  let used = 0;
  while (head < bounded.length && used + size(bounded[head] as ChatSegment) <= half) {
    used += size(bounded[head] as ChatSegment);
    head++;
  }
  let tail = bounded.length;
  used = 0;
  while (tail > head && used + size(bounded[tail - 1] as ChatSegment) <= half) {
    used += size(bounded[tail - 1] as ChatSegment);
    tail--;
  }
  return [...bounded.slice(0, head), { type: 'text', text: '…' }, ...bounded.slice(tail)];
}

/** The text of a turn: its text segments joined with a blank line (empty ones skipped). */
export function chatSegmentsText(segments: readonly ChatSegment[]): string {
  return segments.flatMap((s) => (s.type === 'text' && s.text.trim() ? [s.text.trim()] : [])).join('\n\n');
}

/**
 * Tool activity of a running turn (best effort, not acked). Sent when a tool call starts (`running`), when its result
 * arrives (same `id`, `replace: true`), when a thinking block starts and when a new text block starts after a tool
 * (`{ type: 'text', text: '' }`). `seq` is the segment index within the turn; text itself streams in `chat.delta`.
 */
export const ChatActivitySchema = msg('chat.activity', {
  chatId: z.string(),
  threadId: z.uuid(),
  seq: z.number().int().nonnegative(),
  segment: ChatSegmentSchema,
  replace: z.boolean().optional(),
});
/** Announced in `welcome.features` by servers that accept `chat.activity` (an older server would log and drop it). */
export const CHAT_ACTIVITY_FEATURE = 'chat-activity:1';
export const ChatDeltaSchema = msg('chat.delta', {
  chatId: z.string(),
  threadId: z.uuid(),
  text: z.string(),
});
export const ChatDoneSchema = msg('chat.done', {
  chatId: z.string(),
  threadId: z.uuid(),
/** Announced in `welcome.features` by servers that accept `run.usage` (live usage of a running shift or chat turn, for the provider caps). */
export const RUN_USAGE_FEATURE = 'run-usage:1';
/**
 * What a running shift or chat/session turn has used so far (cumulative, replaces the earlier report). Best effort and not
 * stored: the server counts it toward a provider's monthly cap while the run is going and stops the run at the cap.
 */
export const RunUsageSchema = msg('run.usage', {
  kind: z.enum(['shift', 'chat']),
  /** The shift id, or the chat/session turn id. */
  id: z.string(),
  usage: Usage,
});
  messageText: z.string(),
  usage: Usage,
  /** Runtime session to `--resume` on the next message of this conversation. */
  runtimeSessionId: z.string().optional(),
  /** CEO owner and order turns: what the session used (the server's off-board job backstop reads it). */
  toolCounts: ToolCountsSchema.optional(),
  /** The turn ran in the restricted profile although it asked for full power (`full_power_off`). */
  degraded: z.string().max(40).optional(),
  /** Order turns: the Bash commands the session ran (redacted), for the audit. */
  commands: z.array(z.string().max(500)).max(200).optional(),
  /** The model that answered, when the runtime says. */
  model: z.string().max(120).optional(),
  /** Additive: the full ordered turn (text, tool calls, thinking). `messageText` stays the final answer. */
  segments: z.array(ChatSegmentSchema).max(CHAT_SEGMENTS_MAX).optional(),
});
export const ChatErrorSchema = msg('chat.error', {
  chatId: z.string(),
  threadId: z.uuid(),
  error: z.string(),
});
export const CommandResultSchema = msg('command.result', {
  commandId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
/** Asks the server for a new runner token (`aom-runner rotate-token`); the old one stays valid until the new one connects. */
export const TokenRotateSchema = msg('token.rotate', {});
export const VaultStatusSchema = msg('vault.status', {
  vaultId: z.string(),
  lastPullAt: z.iso.datetime().nullable(),
  lastPushAt: z.iso.datetime().nullable(),
  error: z.string().optional(),
  /** Additive: where the clone lives on the workstation (also reported by `hello.vaults`). */
  localPath: z.string().optional(),
});
/**
 * A deploy run reached a stage on the workstation (docs/design/ceo-front-door.md 9.5). Best effort and not acked: the
 * terminal answer is the durable `command.result` of `deploy.exec`.
 */
export const DeployProgressSchema = msg('deploy.progress', {
  runId: z.uuid(),
  phase: z.enum(['started', 'health', 'smoke']),
  detail: z.string().max(300).optional(),
});
export const VaultConflictSchema = msg('vault.conflict', { vaultId: z.string(), files: z.array(z.string()) });

// ----------------------------------------------------------------- server -> runner

export const WelcomeSchema = msg('welcome', {
  workstationId: z.uuid(),
  serverTime: z.iso.datetime(),
  heartbeatSec: z.number().int().positive().default(HEARTBEAT_SEC),
  limits: z.object({
    /** What the server enforces: the owner's setting (or the runner's own value) capped by the platform. */
    maxConcurrentShifts: z.number().int().positive(),
    /**
     * Additive: the owner's setting (null: none). When present (not undefined) a runner that announced
     * `shift-limit:1` uses `maxConcurrentShifts` as is, ignoring its own config value, and keeps it across restarts.
     */
    shiftLimit: ShiftLimitSettingSchema.optional(),
  }),
  /** Additive, safe mode: the runner version this workstation is pinned to (absent or null: none). */
  runnerPin: z
    .object({ version: z.string().max(40) })
    .nullable()
    .optional(),
  /** Additive: what this server understands beyond the base protocol (`CHAT_ACTIVITY_FEATURE`). */
  features: z.array(z.string()).optional(),
});
export const ShiftStartSchema = msg('shift.start', {
  shiftId: z.uuid(),
  claimId: z.uuid(),
  kind: z.enum(['card', 'question', 'devops', 'ba_task', 'ceo']),
  /** The Claude account this shift runs on; absent = 'main'. Only sent to runners with CLAUDE_ACCOUNTS_CAPABILITY. */
  account: z.object({ key: AccountKeySchema }).optional(),
  agent: AgentRuntimeSpecSchema,
  brief: ShiftBriefSchema,
  worktree: WorktreeSpecSchema.nullable(),
  prepare: z.object({
    rebase: z.boolean(),
    /**
     * Merge the latest main branch first: before the card's worktree is created the runner merges `origin/<main>` into the
     * working branch and pushes it (falling back to the card branch on a conflict or a protected working branch).
     */
    syncMain: z.object({ mainBranch: z.string().optional(), workingBranch: z.string() }).optional(),
  }),
  /** The organization the shift belongs to (the runner resolves the organization source folder with it). */
  orgId: z.uuid().optional(),
  maxShiftMinutes: z.number().int().positive(),
  /** M3: for `kind: 'devops'` the request being worked (the brief then carries a placeholder card). */
  devops: DevopsShiftSchema.optional(),
  /** M7: for `kind: 'question'` the desk item to answer or escalate (the brief then carries the card in question). */
  question: QuestionShiftSchema.optional(),
  /** Phases: for `kind: 'ba_task'` the background task (phase report, follow-up briefs, ...); the brief carries a placeholder card. */
  baTask: BaTaskShiftSchema.optional(),
  /** The CEO agent's wake or daily review (no card, no worktree); the brief carries a placeholder card. */
  ceo: CeoShiftSchema.optional(),
  /** A CEO shift: where the organization graph is (`aom ceo route`). Absent: none. */
  orgGraph: OrgGraphScopeSchema.optional(),
  /** M3: the card's vault (its project vault or the organization vault); the runner reads only this vault and passes only it as `--add-dir`. */
  vault: ShiftVaultSchema.nullable().optional(),
  /** The project's code graph (`arm: 'off'`: the measurement holdout, nothing is offered). Absent: none yet. */
  graph: GraphScopeSchema.optional(),
  /** The project's reference repositories: read-only for this shift when the workstation has a clone. */
  readRepos: z.array(ReadRepoSchema).optional(),
  localReadRepos: z.array(LocalReadRepoSchema).optional(),
  /** Plugin MCP servers the project's Owner granted (names only); a card shift gets the ones its role may call. */
  mcpServers: z.array(z.string()).optional(),
  /** The project's "Commit as" setting, used for every commit of this shift (absent: the clone's or the workstation's git identity). */
  commitAs: CommitAsSchema.nullable().optional(),
  /**
   * Continue this Claude Code session (the agent's own earlier session on this card, group or question) instead of
   * starting cold. The runner refuses it and starts fresh when the stored session is over 120K context tokens, over
   * 4 hours old, belongs to another agent or is unknown here; `shift.session.resume` says which happened.
   */
  resumeSessionId: z.string().optional(),
  /** Lean Team v3: the first message of a resumed session (the answer to its question, or the review findings). */
  resumeMessage: z.string().max(40_000).optional(),
});
export const ShiftStopSchema = msg('shift.stop', { shiftId: z.uuid(), reason: ShiftStopReasonSchema });
/** "Stop the running command": the runner kills the commands the agent runs (its tool process trees); the shift goes on. */
export const ShiftKillToolsSchema = msg('shift.kill_tools', { shiftId: z.uuid() });
export const ShiftReportResultSchema = msg('shift.report.result', {
  reportId: z.uuid(),
  accepted: z.boolean(),
  error: z.string().optional(),
  /** Shown to the agent on acceptance (e.g. what happened to its question). */
  message: z.string().optional(),
  /** Ledger entries that matched a question (duplicate check). */
  matches: z.array(LedgerMatchSchema).optional(),
});
export const RpcResponseSchema = msg('rpc.response', {
  rpcId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
/** The subset of `worktrees.query.paths` that belongs to a live card (not finalized, cancelled or unknown). */
export const WorktreesLiveSchema = msg('worktrees.live', {
  queryId: z.string(),
  live: z.array(z.string()),
});
export const ChatStartSchema = msg('chat.start', {
  chatId: z.string(),
  threadId: z.uuid(),
  agent: AgentRuntimeSpecSchema,
  message: z.string(),
  resumeSessionId: z.string().optional(),
  context: ChatContextSchema,
  /**
   * The CEO's full-power profile (docs/design/ceo-front-door.md section 3.3): the SERVER sets it, only for a CEO chat turn the
   * Owner sent (`owner`) or an Owner-authorized standing order (`order`). The runner honours it only for `agent.roleKey ===
   * 'ceo'` and only with its local opt-in (`aom-runner ceo full-power on`); otherwise it runs the restricted profile and
   * reports `chat.done.degraded`.
   */
  ceoMode: z.enum(['owner', 'order']).optional(),
  /** The fixed working directory of the CEO session (`--resume` keys sessions by it); absent: the Owner's home directory. */
  cwd: z.string().optional(),
  /** Extra working directories (`aom ceo dir add`). */
  addDirs: z.array(z.string()).optional(),
  /** The message waited in the queue since this time (the reply says how long). */
  queuedAt: z.iso.datetime().optional(),
  /**
   * Guildwise context put before the user's message (fenced): the first turn of a session carries the full dynamic context
   * (corrections first, rules, preferences, tasks), later turns a short delta. `handover` starts a new session with a summary.
   */
  briefDelta: z.string().optional(),
  /** Order turns: the authorization the runner checks again (mark and hash) before it starts. */
  order: CeoOrderSpecSchema.optional(),
  /**
   * A turn of a discovery or boardroom session (only sent to a runner that announced `SESSION_TURNS_CAPABILITY`): the
   * runner writes the persona's instructions, runs the headless call read-only and answers with the usual `chat.*`
   * frames (`chatId` is the turn id). An older runner would run it as a plain chat.
   */
  session: SessionTurnSpecSchema.optional(),
});
export const TokenRotatedSchema = msg('token.rotated', { token: z.string().min(1) });
/** A browser started (or stopped) following the logs of a run environment: the runner sends `run.log` only meanwhile. */
export const RunFollowSchema = msg('run.follow', { envId: z.uuid(), follow: z.boolean() });
export const ChatCancelSchema = msg('chat.cancel', { chatId: z.string() });
export const CommandSchema = msg('command', {
  commandId: z.string(),
  command: RunnerCommandNameSchema,
  payload: z.record(z.string(), z.unknown()),
});
/** Either direction. */
/** Where a repository's working branch stands against origin (periodic check, or after "Sync now"). */
export const RepoSyncStatusMsgSchema = msg('repo.sync_status', { status: RepoSyncStatusSchema });
export const AckSchema = msg('ack', { ackOf: z.string().min(1) });

export const RunnerToServerSchema = z.discriminatedUnion('type', [
  HelloSchema,
  OutboxFlushedSchema,
  HeartbeatSchema,
  ReposReportSchema,
  RuntimesReportSchema,
  GitReportSchema,
  OrgFoldersReportSchema,
  McpServersReportSchema,
  ToolchainsReportSchema,
  CapabilitiesReportSchema,
  PacksReportMsgSchema,
  ProjectCapabilitiesReportMsgSchema,
  JiraReportSchema,
  IntegrationsReportSchema,
  IntegrationSessionSchema,
  RunnerUpdateReportSchema,
  ShiftAcceptedSchema,
  ShiftRejectedSchema,
  ShiftStartedSchema,
  ShiftSessionSchema,
  RunnerErrorSchema,
  DevopsAuditSchema,
  RoleSmokeSchema,
  ShiftProgressSchema,
  ShiftReportMsgSchema,
  ShiftEndedSchema,
  RepoSyncStatusMsgSchema,
  RpcRequestSchema,
  WorktreesQuerySchema,
  RunStatusMsgSchema,
  RunLogMsgSchema,
  RunPlanSavedMsgSchemaWire,
  RunReplayFailedMsgSchemaWire,
  ChatDeltaSchema,
  ChatActivitySchema,
  ChatDoneSchema,
  ChatErrorSchema,
  CommandResultSchema,
  VaultStatusSchema,
  VaultConflictSchema,
  DeployProgressSchema,
  TokenRotateSchema,
  AckSchema,
  RunUsageSchema,
]);
export type RunnerToServer = z.infer<typeof RunnerToServerSchema>;

export const ServerToRunnerSchema = z.discriminatedUnion('type', [
  WelcomeSchema,
  ShiftStartSchema,
  ShiftStopSchema,
  ShiftKillToolsSchema,
  ShiftReportResultSchema,
  RpcResponseSchema,
  WorktreesLiveSchema,
  ChatStartSchema,
  ChatCancelSchema,
  CommandSchema,
  TokenRotatedSchema,
  RunFollowSchema,
  AckSchema,
]);
export type ServerToRunner = z.infer<typeof ServerToRunnerSchema>;

export type RunnerToServerType = RunnerToServer['type'];
export type ServerToRunnerType = ServerToRunner['type'];
export type RunnerToServerOf<T extends RunnerToServerType> = Extract<RunnerToServer, { type: T }>;
export type ServerToRunnerOf<T extends ServerToRunnerType> = Extract<ServerToRunner, { type: T }>;

/** Messages the receiver must `ack` (sender persists/retries until acked). `hello` is answered by `welcome`. */
export const RUNNER_ACKED_TYPES: ReadonlySet<string> = new Set<RunnerToServerType>([
  'shift.accepted',
  'shift.rejected',
  'shift.started',
  'shift.session',
  'runner.error',
  'devops.audit',
  'role.smoke',
  'shift.report',
  'shift.ended',
  'chat.done',
  'chat.error',
  'command.result',
  'vault.conflict',
  'run.plan.saved',
  'run.replay.failed',
  'integration.session',
]);
export const SERVER_ACKED_TYPES: ReadonlySet<string> = new Set<ServerToRunnerType>(['shift.stop']);

export const isAckedFromRunner = (type: string): boolean => RUNNER_ACKED_TYPES.has(type);
export const isAckedFromServer = (type: string): boolean => SERVER_ACKED_TYPES.has(type);

/** Builds an envelope: `{ v, id (uuid v7), type, ts, ...payload }`. Validate with the schemas above. */
export function makeEnvelope<T extends string, P extends Record<string, unknown>>(
  type: T,
  payload: P,
  now: Date = new Date(),
  id: string = uuidv7(),
): { v: typeof PROTOCOL_VERSION; id: string; type: T; ts: string } & P {
  return { v: PROTOCOL_VERSION, id, type, ts: now.toISOString(), ...payload };
}
