import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import {
  type AgentRuntimeSpec,
  type BriefAttachment,
  BuildHandoffDataSchema,
  buildEvidenceProblem,
  CHECKS_POLICY,
  type CheckEvidence,
  checkStatusPasses,
  DELEGATE_RPC,
  type GuardViolation,
  HANDOFF_PREP_BUDGET_MS,
  HANDOFF_WORK_BUDGET_MS,
  hasTranscript,
  type InvestigationData,
  type IpcReportRequest,
  type IpcReportResponse,
  type IpcRpcRequest,
  type IpcRpcResponse,
  identityLast,
  isDelegateServerRpc,
  isHandoffCheckRole,
  isPublishRequest,
  isSafeGitRef,
  isTerminalReport,
  isValidReportPath,
  type LedgerMatch,
  normalizeRemoteUrl,
  normalizeUrl,
  type OrgGraphScope,
  outcomeDataSchema,
  type PostAsPlan,
  PREP_OUTCOME,
  PREP_TASK_KINDS,
  type PublishRequest,
  postAsFor,
  type ReadableFolder,
  type RebaseErrorInfo,
  type RepoReport,
  type ResumeState,
  renderCardAttachments,
  renderReadableFolders,
  type ServerToRunnerOf,
  SHIFT_LIMIT_SOURCE_LABEL,
  type ShiftBrief,
  type ShiftCapacity,
  type ShiftLimitSource,
  type ShiftReport,
  ShiftReportSchema,
  type ShiftVault,
  scanReportForSecrets,
  splitBackendModel,
  type TranscriptRef,
  takesShiftSlot,
  UNLIMITED_SHIFTS,
  uuidv7,
  type VaultWriteCommand,
} from '@aom/shared';
import { isReadOnlyWorktreeRole, type ScopedVault } from '../adapters/claude-policy.ts';
import { formatLimitTime } from '../adapters/claude-usage-limit.ts';
import {
  holdWorktree,
  otherShiftsUse,
  removeSandboxStubs,
  usedSince,
} from '../adapters/sandbox-placeholders.ts';
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../adapters/types.ts';
import {
  attachFileFromAgent,
  cardAttachmentsDir,
  describeSynced,
  downloadJiraAttachments,
  listJiraAttachments,
  type ServerHttp,
  syncCardAttachments,
} from '../attachments/index.ts';
import {
  type CapabilityRegistry,
  makePackScriptGate,
  type ProjectIndexResult,
  skillRpc,
} from '../capabilities/registry.ts';
import { detectChecksFromRef, detectUnitSuitesFromRef } from '../checks/detect.ts';
import { RegressionUnits } from '../checks/regression-units.ts';
import { runHandoffChecks } from '../checks/run.ts';
import { checkRunId } from '../checks/units.ts';
import type { RunnerConfig } from '../config.ts';
import type { Outbox } from '../connection/outbox.ts';
import {
  type DelegateCaller,
  DelegateRunner,
  type DelegateWork,
  delegateNote,
  delegateUsageReporter,
} from '../delegate/delegate.ts';
import { recordDevopsAudit } from '../devops/audit.ts';
import {
  type CardWorktreeSnapshot,
  enforceCardFence,
  fenceViolation,
  snapshotCardWorktrees,
} from '../devops/card-fence.ts';
import {
  DEVOPS_INSTALL_RPC,
  type DependencyChange,
  parseDependencyChange,
} from '../devops/dependency-install.ts';
import { devopsPushPlan, devopsRequestIdentity, withAppPushRefusal } from '../devops/devops-git.ts';
import { redactCommand } from '../devops/guard.ts';
import { type HygieneDeps, runHygiene } from '../devops/hygiene.ts';
import { cardPayload, devopsGuardFor, guardedShift, shiftTexts } from '../devops/requests.ts';
import { type ExternalAdapters, formatSource } from '../external/index.ts';
import { checkFeedItemsFetched, FetchedUrls } from '../feeds/validation.ts';
import {
  architectFetch,
  architectMergeMain,
  architectPush,
  architectVerifyMerge,
  type GitReply,
} from '../git/architect-git.ts';
import { computeCardDiff } from '../git/card-diff.ts';
import { baseRef, computeDiffStats, riskTier } from '../git/diffstat.ts';
import { git, gitOk, originBranchNames } from '../git/git.ts';
import {
  AppIdentityError,
  type AppTokenProbe,
  appIdentityWire,
  boundPostAsFor,
  inContext,
  NO_IDENTITY_WIRE,
  repoNameOf,
  resolveCommitIdentity,
} from '../git/identity.ts';
import { finishPrepProposal } from '../git/release-prep-proposal.ts';
import {
  addPrepTaskWorktree,
  finishPrepTask,
  type PrepTaskWorktree,
  removePrepTaskWorktree,
} from '../git/release-prep-task.ts';
import { resetSubmoduleDrift, submoduleResetNote } from '../git/submodule-drift.ts';
import { redactGitError } from '../git/submodule-fill.ts';
import {
  abortMerge,
  mergeInProgress,
  mergeMainIntoCard,
  type SyncMainOutcome,
  syncMainIntoWorking,
} from '../git/sync-main.ts';
import {
  BaseBranchMissingError,
  ensureReadOnlyCheckout,
  ensureWorktree,
  type GitAuth,
  initWorktreeSubmodules,
  RebaseConflictError,
  RebaseError,
  rebaseOntoBase,
  removeReadOnlyCheckout,
  WorktreeError,
  type WorktreeResult,
} from '../git/worktrees.ts';
import { ContextCounter } from '../graph/measure.ts';
import type { GraphService } from '../graph/service.ts';
import { diskProblem } from '../health/disk.ts';
import type { IpcServer, ShiftIpcHandler } from '../ipc/server.ts';
import { type Logger, nullLogger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import { playbookNote } from '../playbooks/note.ts';
import { mergeReadFolders, resolveOrgFolderRepos, resolveReadRepos } from '../read-repos.ts';
import { preparePublication } from '../research/publish.ts';
import { type EnvForwards, startForwards } from '../runs/forward.ts';
import type { RunManager } from '../runs/manager.ts';
import {
  agentTmpHeld,
  cleanAgentTmp,
  DEVOPS_MARKER,
  ensureSandbox,
  holdAgentTmp,
  type Sandbox,
  sandboxEnv,
} from '../sandbox/sandbox.ts';
import { DEFAULT_SCRATCH_POLICY, describePrune, pruneScratch } from '../sandbox/scratch.ts';
import {
  allowedServices,
  decideCheckServices,
  decideTestServices,
  isTesterShift,
  noTestServicesNote,
  notAnsweringLine,
  refusedProgress,
  TEST_SERVICE_ROLES,
  type TestServiceDecision,
  type TestServicesSeen,
  testerScratchNote,
  testerShiftEnv,
  testServiceDomains,
  testServicesNote,
  testServicesSpec,
  withReachability,
} from '../sandbox/test-services.ts';
import type { TargetSecrets } from '../secrets/targets.ts';
import { type IssuedShiftCredential, issueShiftCredential } from '../session/shift-credential.ts';
import { copySessionTranscript, SessionRegistry } from '../sessions/registry.ts';
import { e2eAreasSection } from '../testing/e2e-areas.ts';
import { defaultEnvChecker, type EnvChecker, needsTestEnvironment } from '../testing/environment.ts';
import { environmentNote } from '../testing/environment-note.ts';
import { probeTargetUrl, targetHosts } from '../testing/remote-target.ts';
import { testerRpc } from '../testing/tester-env.ts';
import { type PrepResult, type PrepStep, prepareWorktree, prepNote } from '../toolchain/prepare-worktree.ts';
import {
  agentPath,
  describeToolchains,
  type ToolchainRegistry,
  toolchainNote,
  toolchainRpc,
} from '../toolchain/registry.ts';
import type { Platform } from '../toolchain/types.ts';
import type { TranscriptDeps, TranscriptResult } from '../transcript/fetch.ts';
import {
  defaultTranscriptDeps,
  fetchTranscript,
  mockTranscript,
  refOf,
  renderTranscriptFile,
  renderTranscriptMessage,
  transcriptPath,
} from '../transcript/service.ts';
import { readVaultContexts, withVaultContexts } from '../vaults/context.ts';
import {
  type AutoCommitResult,
  autoCommit,
  autoCommitRefusedNote,
  describeRefusal,
  uncommittedFiles,
  unreportedWorkNote,
} from './autocommit.ts';
import {
  type BranchSnapshot,
  type DirtySnapshot,
  discardOutOfScope,
  discardTestArtifacts,
  fetchedRemoteTip,
  type GuardInput,
  mayEdit,
  ownerOf,
  resetReadOnlyWorktree,
  runGuard,
  snapshotBranches,
  snapshotDirty,
  uncommittedOutOfScope,
  workRefGuardInput,
} from './guard.ts';

type ShiftStartMsg = ServerToRunnerOf<'shift.start'>;
type ReportResultMsg = ServerToRunnerOf<'shift.report.result'>;
type StopReason = ServerToRunnerOf<'shift.stop'>['reason'];

/** The shift limit in force (`UNLIMITED_SHIFTS` or more: none) and where it comes from. */
export interface ShiftCap {
  max: number;
  source: ShiftLimitSource;
}

/** The `capacity` of a `busy` rejection: the limit, its source and the shifts holding the slots (identifiers only). */
export function capacityOf(
  cap: ShiftCap,
  holders: ReadonlyArray<{ msg: Pick<ShiftStartMsg, 'shiftId' | 'kind' | 'brief' | 'agent'> }>,
): ShiftCapacity {
  return {
    limit: cap.max,
    source: cap.source,
    running: holders.length,
    holders: holders.slice(0, 50).map((h) => ({
      shiftId: h.msg.shiftId,
      kind: h.msg.kind,
      ...(h.msg.kind === 'card' && h.msg.brief.card?.ref
        ? { cardRef: h.msg.brief.card.ref.slice(0, 40) }
        : {}),
      ...(h.msg.agent.name ? { agentName: h.msg.agent.name.slice(0, 80) } : {}),
    })),
  };
}

/**
 * The text of a `busy` rejection: "4 shifts already running (limit 4), source: workstation setting; held
 * by GWP-94 (Ada), devops (Anvil)". It starts with the text older runners sent ("4 shifts already running (limit 4)"), so readers that
 * match that prefix keep working.
 */
export function busyDetail(capacity: ShiftCapacity): string {
  const label = SHIFT_LIMIT_SOURCE_LABEL[capacity.source as ShiftLimitSource] ?? capacity.source;
  const limit = capacity.limit >= UNLIMITED_SHIFTS ? 'none' : String(capacity.limit);
  const refs = capacity.holders
    .map((h) => `${h.cardRef ?? h.kind}${h.agentName ? ` (${h.agentName})` : ''}`)
    .join(', ');
  return `${capacity.running} shifts already running (limit ${limit}), source: ${label}${refs ? `; held by ${refs}` : ''}`.slice(
    0,
    500,
  );
}

export interface ShiftTransport {
  /** Acked types are persisted and retried; best-effort types are dropped while offline. */
  send(type: string, payload: Record<string, unknown>): string;
}

export interface SupervisorDeps {
  /**
   * UAT 1.10.0 finding 3: a DevOps shift asks for approval (`aom devops-approval`); the runner checks whether a switch of
   * this workstation that is off explains it, to show that on Approvals on this computer.
   */
  onDevopsApproval?: (msg: ShiftStartMsg, data: Record<string, unknown>) => void;
  /** The capability registry (`aom skill show|list`, and the index in the instructions of an agent whose role lists skills). */
  capabilities?: CapabilityRegistry;
  /** The capabilities found in a project's checkout changed: tell the server (metadata only). */
  onProjectCapabilities?: (projectId: string, r: ProjectIndexResult) => void;
  paths: RunnerPaths;
  config: RunnerConfig;
  adapters: Map<string, RuntimeAdapter>;
  ipc: IpcServer;
  /** easy-runner-setup [B3]: this process's approvals page port, never opened to a sandbox. */
  windowPort?: () => number | undefined;
  transport: ShiftTransport;
  outbox: Outbox;
  log?: Logger;
  /** Finds the local clone for a normalized remote URL. */
  findRepo: (remoteUrlNormalized: string) => Promise<RepoReport | undefined>;
  /** This runner's app token probe (its own key store and broker); none: a shift for a selected app fails closed. */
  appProbe?: AppTokenProbe | null;
  /** This workstation's clone by catalog key (path relative to a repoRoot): reference repositories picked on this workstation. */
  findLocal?: (localKey: string) => Promise<{ localPath: string } | undefined>;
  /** The runner's HTTP calls to the server (attachment bytes). Absent: attachments are not copied. */
  http?: ServerHttp;
  /** Forwards an rpc to the server (`rpc.request`). */
  rpc: (shiftId: string, method: string, params: Record<string, unknown>) => Promise<IpcRpcResponse>;
  /** The project graph (docs/design/project-graphs.md): `aom graph ...` and the "Graph context" section. Absent: none. */
  graph?: () => GraphService | undefined;
  /** `aom recipe save`: write a drafted delivery recipe into the project vault (docs/design/ceo-front-door.md 10). */
  recipeSave?: (shiftId: string, params: Record<string, unknown>) => Promise<IpcRpcResponse>;
  /** `aom deploy probe` (DevOps in a scan): the fixed read-only probe, answered on this workstation. */
  deployProbe?: (
    shiftId: string,
    params: Record<string, unknown>,
    targets: Array<{ name: string; host: string | null }>,
  ) => Promise<IpcRpcResponse>;
  /** Writes (and commits, pushes) a file into a vault clone: `aom publish` puts research notes there (M6). */
  writeVault?: (
    cmd: VaultWriteCommand,
  ) => Promise<{ written: boolean; committed: boolean; pushed: boolean; paused: boolean }>;
  /** The shift limit in force and its source (default: `config.json`'s `maxConcurrentShifts`, source runner config). */
  shiftCap?: () => ShiftCap;
  /** Runs before a shift is put back for an expired login: the runner tells the server the runtime is paused first. */
  beforeAuthReject?: () => Promise<void>;
  /** Text for the agent's instructions about granted MCP servers that need a sign-in here (empty: none). */
  mcpSignInNote?: (granted: readonly string[] | undefined) => string;
  /** Test/dev override of `maxShiftMinutes` (milliseconds). */
  maxShiftMsOverride?: number;
  /** How long a report waits for `shift.report.result` before being treated as queued. Default 120 s. */
  /** `aom runner restart` in a DevOps shift: the restart waits for the shift's end to be acknowledged. */
  onRunnerRestart?: (shiftId: string, reason: string | undefined) => void;
  /** Called after `shift.ended` was queued (with its outbox frame id). */
  onShiftEnded?: (shiftId: string, frameId: string | undefined) => void;
  reportWaitMs?: number;
  /** How long the session may linger after an accepted report. Default 2 min. */
  exitGraceMs?: number;
  progressFlushMs?: number;
  /** The server accepts `run.usage` (live usage for the provider caps); absent: no. */
  liveUsage?: () => boolean;
  /** The server accepts the live usage of a delegate (it announced `DELEGATE_GRANTS_FEATURE`). */
  delegateUsage?: () => boolean;
  /** Tester environment check before the session starts (default: Docker and the deployed app). */
  envChecker?: EnvChecker;
  /** How `aom transcript` reaches yt-dlp and the web (default: the real ones; tests inject fakes). */
  transcript?: TranscriptDeps;
  /**
   * `aom devops install` (owner 2026-11-21): the DevOps side of the runner runs a project package install in the shift's
   * worktree under the local policy (the agent's scrubbed Bash cannot write package.json or the lockfiles).
   */
  devopsInstall?: (req: {
    shiftId: string;
    dir: string;
    repo: string;
    change: DependencyChange;
  }) => Promise<IpcRpcResponse>;
  /** `aom git status|connect` for the DevOps engineer (the runner drives the login on this workstation). */
  git?: { handle(method: string, params: Record<string, unknown>): Promise<IpcRpcResponse> };
  /** The ticket systems of this workstation: a batch intake shift reads its ticket (`aom source read`) like an intake chat. */
  external?: () => ExternalAdapters | undefined;
  /** Credentials for pushing a working branch the runner creates (absent: the user's own git setup). */
  gitAuth?: GitAuth;
  /**
   * Credentials for one shift from its post-as plan: repositories that post as an app push and fetch with this runner's
   * installation tokens, every other repository with `gitAuth`. `originRefusal` is the fail-closed check of a clone's
   * origin (an app pushes over https only), as a wire error. Absent: `gitAuth` for every shift, as before.
   */
  shiftCredentials?: (plan: PostAsPlan | null | undefined) => {
    auth: GitAuth;
    originRefusal(url: string | null | undefined): string | null;
    /** The app a remote URL posts as under this plan (null = today's credentials and identity). No secret. */
    appFor?(url: string): { label: string; botName: string; botEmail: string } | null;
  };
  /** The organization source folder of an organization (the architect reads every repository under it, read-only). */
  orgSourceFolder?: (orgId: string) => string | undefined;
  /** Brings the local working branch of a repository up to date after a fetch (runs under the clone's lock). */
  syncAfterFetch?: (target: {
    repoId: string;
    remoteUrlNormalized: string;
    workingBranch: string;
  }) => Promise<void>;
  /** Idle watchdog thresholds and clock (tests shorten them). */
  idle?: Partial<IdleLimits> & { now?: () => number };
  /** Agent toolchains (PATH, read access, variables of sandboxed agents; `aom toolchain` of the DevOps engineer). */
  toolchains?: ToolchainRegistry;
  /** Run a branch (#58): the environments `aom run` of a DevOps `run` request works on. */
  runs?: RunManager;
  /** Test hook: how a new card worktree is prepared (default: `prepareWorktree`). */
  prepareWorktree?: typeof prepareWorktree;
  /** Test hook: the time budget of a handoff's checks (default `CHECKS_BUDGET_MS`). */
  checksBudgetMs?: number;
  /** Test hook: how a card worktree's submodules are filled (default: `initWorktreeSubmodules`). */
  initWorktreeSubmodules?: typeof initWorktreeSubmodules;
  /** Called after the local test services seen at a shift start changed (the runner writes them to its status file). */
  onTestServices?: () => void;
  /** Test accounts for deploy targets (the tester of a remote target gets them as a 0600 dotenv file). */
  targetSecrets?: TargetSecrets;
  /** Test hook: how a remote target is probed before a tester shift starts (default: an HTTP request). */
  probeTarget?: (url: string) => Promise<string | null>;
  /** Test hook: whether a declared local test service answers at shift start (default: a 1 s TCP connect). */
  probePort?: (host: string, port: number) => Promise<boolean>;
  /** Claude sessions started on this workstation (resume decisions); default: `<data dir>/sessions.json`. */
  sessions?: SessionRegistry;
  /** Test hook: free bytes of a folder (default: statfs). */
  diskFree?: (path: string) => number;
  /** Test hook: where the OS temp folder is (the disk check measures it). */
  diskTmpDir?: string;
  /** Free-space limits of the disk check (tests lower them). */
  diskLimits?: { minTmp?: number; minData?: number };
  /** After the server released the claim of a shift whose report was accepted: how long Claude gets to write its result line. Default 5 s. */
  claimLostGraceMs?: number;
  /** How often a running session's context size is sent to the server. Default 2 min. */
  contextReportMs?: number;
  /** An unexpected failure of the runner's own code while handling a shift (sent to the server as `runner.error`). */
  reportError?: (err: unknown, context: string) => void;
}

/** The server's answer to a `shift.report`: what the agent is told (and any ledger matches for a question). */
interface ReportVerdict {
  accepted: boolean;
  error?: string;
  message?: string;
  matches?: LedgerMatch[];
  /** Accepted but not terminal: the shift carries on. */
  continueShift?: boolean;
}

/** Roles whose stages only read the code and record a verdict: they make no commits of their own. */
const READ_ONLY_ROLES = new Set(['planner', 'pre_reviewer', 'reviewer']);

/** The tracker ticket key the card came from (`DCPL-4276`), the only reference that may appear in a commit message. */
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const ticketOf = (msg: ShiftStartMsg): string | null => {
  const k = msg.brief.card.fields.externalRef;
  return typeof k === 'string' && TICKET_KEY.test(k.trim()) ? k.trim() : null;
};

interface ActiveShift {
  msg: ShiftStartMsg;
  /** What a delegate that works shares with this shift (its working directory and read folders). */
  delegateWork?: DelegateWork;
  startedAt: Date;
  token?: string;
  /** The token's env file; `revoke()` ends both (see session/shift-credential.ts). */
  credential?: IssuedShiftCredential;
  session?: RuntimeSession;
  worktree?: WorktreeResult;
  /** A design before the dependencies landed: a detached read-only checkout of the working branch, removed at the end. */
  readOnlyCheckout?: { path: string; repoPath: string; baseBranch: string };
  /** A release prep task: its detached worktree from the release work ref. */
  prepTask?: PrepTaskWorktree;
  startSha?: string;
  branchesAtStart: BranchSnapshot;
  /** The branches origin had at this shift's fetch (reported on shift.started so the server's branch list is fresh). */
  originBranches?: string[];
  stopReason?: StopReason | 'timeout' | 'idle';
  /** Idle watchdog: when the runtime last produced anything, whether its turn finished, and when it was told off. */
  lastActivity: number;
  turnDone: boolean;
  idleNoteAt?: number;
  idleBusy?: boolean;
  reportState: 'none' | 'pending' | 'accepted';
  pendingReports: Map<string, (r: ReportVerdict) => void>;
  guardViolations: GuardViolation[];
  /** A DevOps shift: the card worktrees when it started (devops/card-fence.ts, uat-runner-fixes-3 finding 2). */
  cardFence?: { before: CardWorktreeSnapshot; startedAtMs: number; ended?: boolean };
  finalText?: string;
  progress: Array<{ at: string; kind: 'text' | 'tool' | 'status'; text: string }>;
  env: Record<string, string>;
  graceTimer?: NodeJS.Timeout;
  /** Pages the agent opened with its web tools (no fabrication: reported feed items must be among them). */
  fetched: FetchedUrls;
  /** Transcripts fetched in this shift with `aom transcript`, by normalized URL. */
  transcripts: Map<string, { ref: TranscriptRef; title: string }>;
  /** The brief the agent sees: the server's brief plus what the runner read from the vault (PROJECT.md, taste.md). */
  brief?: ShiftBrief;
  /** What the shift took to find its way in the code (sent on `shift.ended` as numbers). */
  counter?: ContextCounter;
  /** Resumed after a runner restart: the server already holds the claim and has seen accepted/started. */
  resumed?: boolean;
  /** The card branch was rebased (or merged) onto its base before the shift: the commit moved with it. */
  rebased?: boolean;
  startedSent?: boolean;
  sandbox?: Sandbox;
  /** The commit identity resolved for this shift (project setting, repository, workstation); null when none is set. */
  identity?: { name: string; email: string; source: string } | null;
  /** What the "merge latest main first" step did (reported with `shift.started`). */
  syncMain?: { result: NonNullable<ShiftStartedSyncMain['result']>; commit?: string; files?: string[] };
  /** `origin/<main>` SHAs merged into the card branch this shift: the guard exempts what those merges brought in. */
  mainShas: string[];
  /** Shas of the card's base and working branch (local and origin/): merges of them are exempt in the guard. */
  baseTips: string[];
  /** Fingerprints of the paths already dirty at the shift start: unchanged ones are not this shift's doing (guard). */
  dirtyAtStart?: DirtySnapshot;
  /** Refusals of the leftovers commit already noted on the card this shift (reason and tree): one note each. */
  autoCommitRefusals: Set<string>;
  /** When the shift's start sha was taken (ms since epoch). */
  startedAtMs?: number;
  /** A handoff's checks are running (a second `aom handoff` meanwhile is refused). */
  checksRunning?: boolean;
  /** A suite card's unit suites, run by the runner in the background (tester shifts with `brief.regressionUnits`). */
  regressionUnits?: RegressionUnits;
  /** The hash of the last refusal posted on the card this shift (the same refusal is posted once). */
  lastRefusalHash?: string;
  /** The dependencies were prepared (or found prepared) before this shift's handoff checks. */
  depsRefreshed?: boolean;
  /** Aborted when the shift ends: kills the running checks. */
  checkAbort?: AbortController;
  /** Aborted when the shift is stopped: ends the preparation of a new worktree. */
  prepAbort?: AbortController;
  /** What preparing the new card worktree did (reported with `shift.started`, told to the agent). */
  worktreePrep?: PrepResult;
  /** What filling the card worktree's submodules did (one `submodules` step; part of `worktreePrep`). */
  submodulesStep?: PrepStep;
  /** Check results by head, check and command: a second handoff at the same head does not run them again. */
  checkCache?: Map<string, { evidence: CheckEvidence; log: string }>;
  /** The tester's environment forwarders (Unix sockets to the environment's ports), closed when the shift ends. */
  forwards?: EnvForwards;
  /** Releases the hold on the agent's TMPDIR (see `holdAgentTmp`). */
  releaseTmp?: () => void;
  /** Releases this shift's claim on its worktree (the sandbox stubs stay while another shift uses it). */
  releaseWorktree?: () => void;
  /** The server accepted a terminal report of this shift (as opposed to `reportState`, which a lost claim also sets). */
  reportAccepted?: boolean;
  /** Resolves when the agent's event stream has ended (the process is gone and its result line was read). */
  streamEnded?: Promise<void>;
  /** Settled when the verdict of a terminal report in flight is applied (or timed out); undefined without one. */
  terminalVerdict?: Promise<void>;
  /** Claude's session id of this shift, once the stream said it. */
  runtimeSessionId?: string;
  /** The session this shift was asked to resume, and what the runner decided (reported with the first session update). */
  resumeAsked?: { sessionId: string; state: ResumeState; detail?: string; cwd: string };
  lastContextSent?: number;
  usageSentAt?: number;
}

type ShiftStartedSyncMain = {
  result: 'merged_into_working' | 'merged_into_card' | 'conflict_in_card' | 'skipped_conflict';
};

/** On-disk record of a running shift (`<dataDir>/active-shifts/<shiftId>.json`). */
interface PersistedShift {
  msg: ShiftStartMsg;
  startedSent: boolean;
  mainShas?: string[];
  baseTips?: string[];
  dirtyAtStart?: DirtySnapshot;
}

/**
 * Idle watchdog (backlog #53). A shift whose agent process is alive but silent is not making progress (a hung test
 * run, a command waiting for a service the sandbox cannot reach). After `doneMs` of silence once a turn finished, or
 * `turnMs` during a turn, the commands it runs are killed and a note says so; if it is still silent `graceMs` later
 * the shift is stopped (the end-of-shift code saves the work and notes what was left unreported).
 */
export interface IdleLimits {
  turnMs: number;
  doneMs: number;
  graceMs: number;
  checkMs: number;
}
export const IDLE_LIMITS: IdleLimits = {
  turnMs: 20 * 60_000,
  doneMs: 8 * 60_000,
  graceMs: 5 * 60_000,
  checkMs: 30_000,
};

/** The workflow stage of the QA-steps shifts (the server's `QA_STEPS_STAGE`); they are short. */
const QA_STEPS_STAGE = 'qa_steps';
/** The longest design report text attached to an investigation hand-off (the schema's cap). */
const REPORT_TEXT_MAX = 200_000;

const ACCEPTED_MESSAGE = 'Recorded. Finish now; do not make further changes.';

/**
 * The vaults a shift reads (read-only). A card shift reads every vault the server named (`vaults`; an older server
 * sends only `vault`); question, BA task and CEO shifts read their one `vault`; any other shift reads none.
 */
export function shiftVaultsOf(msg: {
  kind?: string;
  vault?: ShiftVault | null;
  vaults?: ShiftVault[];
}): ShiftVault[] {
  if (msg.kind === 'card') return msg.vaults?.length ? msg.vaults : msg.vault ? [msg.vault] : [];
  return (msg.kind === 'question' || msg.kind === 'ba_task' || msg.kind === 'ceo') && msg.vault
    ? [msg.vault]
    : [];
}

/**
 * The vault clones a shift reads only in part: a card shift reads the organization vault without the other projects'
 * folders (the root, everything outside projects/ and its own project folder, the folder the server resolved for the
 * card, never derived from the key). Every other shift, and every other vault, opens whole.
 */
export function cardScopedVaults(
  shiftKind: string | undefined,
  vaultCtxs: ReadonlyArray<{ kind?: string; addDir: string; folder?: string }>,
): ScopedVault[] {
  if (shiftKind !== 'card') return [];
  return vaultCtxs.flatMap((c) =>
    c.kind === 'org' && c.folder ? [{ dir: c.addDir, keep: join(c.addDir, ...c.folder.split('/')) }] : [],
  );
}

export class ShiftSupervisor {
  private readonly active = new Map<string, ActiveShift>();
  private readonly log: Logger;

  private readonly sessions: SessionRegistry;
  /** `aom delegate`: read-only persona sub-tasks of a running shift (costs booked under the shift). */
  private readonly delegates: DelegateRunner;

  /** The local test services each project declared at its latest shift start (doctor display only; never feeds settings). */
  private readonly testServicesSeen = new Map<string, TestServicesSeen>();

  constructor(private readonly deps: SupervisorDeps) {
    this.log = deps.log ?? nullLogger;
    this.delegates = new DelegateRunner({
      adapters: deps.adapters,
      paths: deps.paths,
      ipc: deps.ipc,
      rpc: (id, method, params) => deps.rpc(id, method, params),
      reportUsage: delegateUsageReporter(
        () => deps.delegateUsage?.() === true,
        (id, usage) => deps.transport.send('run.usage', { kind: 'delegate', id, usage }),
      ),
      ...(deps.capabilities ? { capabilities: deps.capabilities } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
    this.sessions = deps.sessions ?? new SessionRegistry(join(deps.paths.root, 'sessions.json'));
    // native subagents of a session that was running when this runner last stopped are booked from their transcripts
    this.delegates.startNativeRecovery();
  }

  /** Shifts that are running (for `hello` and heartbeats). */
  activeShifts(): Array<{ shiftId: string; cardId?: string; agentId: string; startedAt: string }> {
    return [...this.active.values()]
      .filter((s) => s.session || s.resumed)
      .map((s) => ({
        shiftId: s.msg.shiftId,
        // a DevOps shift has no card (its brief carries a placeholder)
        ...(s.msg.kind === 'card' && s.msg.brief.card ? { cardId: s.msg.brief.card.id } : {}),
        agentId: s.msg.agent.agentId,
        startedAt: s.startedAt.toISOString(),
      }));
  }

  get size(): number {
    return this.active.size;
  }

  /** Shifts that take a slot of the shift limit (`takesShiftSlot`: the CEO shift does not; chats run elsewhere). */
  get slotCount(): number {
    let n = 0;
    for (const a of this.active.values()) if (takesShiftSlot(a.msg.kind)) n++;
    return n;
  }

  /** The shift limit in force for the next start and where it comes from. */
  shiftCap(): ShiftCap {
    return this.deps.shiftCap?.() ?? { max: this.deps.config.maxConcurrentShifts, source: 'runner_config' };
  }

  /** Worktree paths of the shifts that are running or starting (the stale-worktree sweep leaves them alone). */
  worktreePaths(): string[] {
    const out: string[] = [];
    for (const s of this.active.values()) {
      if (s.worktree) out.push(s.worktree.path);
      if (s.readOnlyCheckout) out.push(s.readOnlyCheckout.path);
      if (s.prepTask) out.push(s.prepTask.path);
      const spec = s.msg.worktree;
      if (spec) {
        if (spec.path) out.push(spec.path);
        out.push(
          this.deps.paths.worktreePath(s.msg.brief.project.key, s.msg.brief.card.ref, s.msg.brief.project.id),
        );
      }
    }
    return out;
  }

  /** Resolves when the shift has fully ended (or was rejected). Never throws. */
  private readonly settling = new Map<string, Promise<void>>();

  /** Resolves when the shift's handleStart, including its temp cleanup, has returned; at once for an unknown id. */
  whenSettled(shiftId: string): Promise<void> {
    return this.settling.get(shiftId) ?? Promise.resolve();
  }

  /** Resolves when every shift now being wrapped up has finished its cleanup. */
  async settledAll(): Promise<void> {
    await Promise.all([...this.settling.values()]);
  }

  async handleStart(
    msg: ShiftStartMsg,
    resume?: { startedSent: boolean; mainShas?: string[]; baseTips?: string[]; dirtyAtStart?: DirtySnapshot },
  ): Promise<void> {
    if (this.active.has(msg.shiftId)) return; // redelivery
    // The CEO's management shift has a slot of its own (one at a time, outside the owner's limit like a chat): a
    // workstation full of card shifts used to refuse it every time and nothing was logged (backlog #79). Which kinds
    // take a slot is one rule shared with the server and the Workstations page (`takesShiftSlot`).
    if (msg.kind === 'ceo') {
      if ([...this.active.values()].some((a) => a.msg.kind === 'ceo')) {
        this.reject(msg.shiftId, 'busy', 'a CEO shift is already running');
        return;
      }
    } else {
      const cap = this.shiftCap();
      const holders = [...this.active.values()].filter((a) => takesShiftSlot(a.msg.kind));
      if (holders.length >= cap.max) {
        const capacity = capacityOf(cap, holders);
        this.reject(
          msg.shiftId,
          'busy',
          busyDetail(capacity),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          capacity,
        );
        return;
      }
    }
    const shift: ActiveShift = {
      msg,
      startedAt: new Date(),
      lastActivity: Date.now(),
      turnDone: false,
      branchesAtStart: {},
      reportState: 'none',
      pendingReports: new Map(),
      guardViolations: [],
      progress: [],
      fetched: new FetchedUrls(),
      transcripts: new Map(),
      counter: new ContextCounter(msg.graph?.arm ?? 'none'),
      env: {},
      mainShas: resume?.mainShas ? [...resume.mainShas] : [],
      baseTips: resume?.baseTips ? [...resume.baseTips] : [],
      ...(resume?.dirtyAtStart ? { dirtyAtStart: { ...resume.dirtyAtStart } } : {}),
      autoCommitRefusals: new Set<string>(),
      ...(resume ? { resumed: true, startedSent: resume.startedSent } : {}),
    };
    this.active.set(msg.shiftId, shift);
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    this.settling.set(msg.shiftId, settled);
    try {
      await this.run(shift);
    } catch (err) {
      this.log.error(`shift ${msg.shiftId} failed unexpectedly`, err);
      this.deps.reportError?.(err, `shift.${msg.kind}`);
      if (!shift.session)
        this.reject(msg.shiftId, 'internal', err instanceof Error ? err.message : String(err));
    } finally {
      // an unexpected error skipped the shift end: the card worktrees are still checked (REVIEW B2)
      if (shift.cardFence && !shift.cardFence.ended)
        await this.endCardFence(shift).catch((err) =>
          this.log.error(`shift ${msg.shiftId}: the card worktree check failed`, err),
        );
      if (shift.readOnlyCheckout)
        await removeReadOnlyCheckout(shift.readOnlyCheckout.repoPath, shift.readOnlyCheckout.path);
      if (shift.prepTask) await removePrepTaskWorktree(shift.prepTask);
      if (shift.credential) shift.credential.revoke();
      else if (shift.token) this.deps.ipc.revoke(shift.token);
      this.delegates.endCaller(msg.shiftId, 'the shift ended');
      if (shift.graceTimer) clearTimeout(shift.graceTimer);
      shift.forwards?.close();
      shift.checkAbort?.abort();
      shift.releaseWorktree?.();
      this.active.delete(msg.shiftId);
      // every outcome (done, crash, stop, timeout): the agent's per-shift temp content goes (backlog #81)
      shift.releaseTmp?.();
      if (shift.sandbox) {
        await cleanAgentTmp(shift.sandbox.tmp);
        // scratch retention: age and size limits (a no-op while another shift or chat of the agent runs)
        const sb = shift.sandbox;
        const r = await pruneScratch(sb.scratch, this.deps.config.scratch ?? DEFAULT_SCRATCH_POLICY, () =>
          agentTmpHeld(sb.tmp),
        );
        if (r.pruned.length) this.log.info(describePrune(shift.msg.agent.agentId, r));
      }
      this.forget(msg.shiftId);
      if (this.settling.get(msg.shiftId) === settled) this.settling.delete(msg.shiftId);
      settle();
    }
  }

  /**
   * Resumes the shifts a previous runner process left running (SIGKILL, crash, restart). The server keeps the claim
   * while the workstation is back within the lease, so the shift is started again under the same id in the same
   * worktree. If the server released it meanwhile, it answers `hello` with `shift.stop{claim_lost}`.
   */
  resumePersisted(): void {
    let files: string[] = [];
    try {
      files = readdirSync(this.deps.paths.activeShifts).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const f of files) {
      try {
        const rec = JSON.parse(readFileSync(join(this.deps.paths.activeShifts, f), 'utf8')) as PersistedShift;
        this.log.info(`resuming shift ${rec.msg.shiftId} after runner restart`);
        void this.handleStart(rec.msg, {
          startedSent: rec.startedSent,
          ...(rec.mainShas ? { mainShas: rec.mainShas } : {}),
          ...(rec.baseTips ? { baseTips: rec.baseTips } : {}),
          ...(rec.dirtyAtStart ? { dirtyAtStart: rec.dirtyAtStart } : {}),
        });
      } catch (err) {
        this.log.warn(`ignoring unreadable persisted shift ${f}: ${String(err)}`);
        rmSync(join(this.deps.paths.activeShifts, f), { force: true });
      }
    }
  }

  /** Agent ids of the persisted (to be resumed) shifts: their TMPDIR must survive the startup sweep. */
  persistedAgentIds(): string[] {
    const out: string[] = [];
    let files: string[] = [];
    try {
      files = readdirSync(this.deps.paths.activeShifts).filter((f) => f.endsWith('.json'));
    } catch {
      return out;
    }
    for (const f of files) {
      try {
        const rec = JSON.parse(readFileSync(join(this.deps.paths.activeShifts, f), 'utf8')) as PersistedShift;
        out.push(rec.msg.agent.agentId);
      } catch {
        /* unreadable: resumePersisted discards it */
      }
    }
    return out;
  }

  private persist(s: ActiveShift): void {
    try {
      mkdirSync(this.deps.paths.activeShifts, { recursive: true });
      const file = join(this.deps.paths.activeShifts, `${s.msg.shiftId}.json`);
      const rec: PersistedShift = {
        msg: s.msg,
        startedSent: !!s.startedSent,
        ...(s.mainShas.length ? { mainShas: s.mainShas } : {}),
        ...(s.baseTips.length ? { baseTips: s.baseTips } : {}),
        ...(s.dirtyAtStart ? { dirtyAtStart: s.dirtyAtStart } : {}),
      };
      writeFileSync(`${file}.tmp`, JSON.stringify(rec), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      this.log.warn(`could not persist shift ${s.msg.shiftId}: ${String(err)}`);
    }
  }

  private forget(shiftId: string): void {
    rmSync(join(this.deps.paths.activeShifts, `${shiftId}.json`), { force: true });
  }

  async handleStop(shiftId: string, reason: StopReason): Promise<void> {
    const s = this.active.get(shiftId);
    if (!s) return;
    // The server releases the claim as soon as it accepted the report, and that used to kill the process 1.5 s later,
    // before Claude wrote its result line: 577 such shifts recorded estimated usage and were labelled "stopped". Give a
    // session whose report was accepted a short grace to finish by itself (its usage is then the real one).
    // A terminal report whose verdict is still in flight (the stop can arrive in the same socket read as the verdict)
    // is waited for first; both waits share one deadline.
    const grace = this.deps.claimLostGraceMs ?? 5_000;
    const deadline = Date.now() + grace;
    if (reason === 'claim_lost' && s.reportState === 'pending' && s.terminalVerdict) {
      let t: NodeJS.Timeout | undefined;
      await Promise.race([
        s.terminalVerdict,
        new Promise<void>((resolve) => {
          t = setTimeout(resolve, grace);
          t.unref?.();
        }),
      ]);
      if (t) clearTimeout(t);
    }
    const afterAccepted = reason === 'claim_lost' && s.reportAccepted === true;
    if (afterAccepted && s.streamEnded) {
      let timer: NodeJS.Timeout | undefined;
      const done = await Promise.race([
        s.streamEnded.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (done) return;
    }
    if (!afterAccepted) s.stopReason ??= reason;
    s.prepAbort?.abort();
    if (reason === 'claim_lost') {
      s.reportState = 'accepted'; // no further reports for a shift the server no longer holds
      this.deps.outbox.discard((e) => e.type === 'shift.report' && e.frame.shiftId === shiftId);
      for (const [id, cb] of s.pendingReports) {
        s.pendingReports.delete(id);
        cb({ accepted: false, error: 'claim lost: the server no longer holds this shift' });
      }
    }
    await s.session?.stop(`stop:${reason}`);
  }

  /** "Stop the running command": kills the commands the agent runs and lets the shift go on. Returns how many processes. */
  async killTools(shiftId: string): Promise<number> {
    const s = this.active.get(shiftId);
    if (!s?.session?.killTools) return 0;
    const n = await s.session.killTools();
    this.addProgress(
      s,
      'status',
      n > 0 ? `the running command was stopped (${n} process(es))` : 'no running command to stop',
    );
    this.flushProgress(s);
    return n;
  }

  private async idleCheck(s: ActiveShift, limits: IdleLimits, now: () => number): Promise<void> {
    if (s.idleBusy || !s.session || s.stopReason || s.reportState !== 'none') return;
    s.idleBusy = true;
    try {
      const t = now();
      const last = Math.max(s.lastActivity, s.session.lastActivityAt?.() ?? 0);
      if (s.idleNoteAt !== undefined && last > s.idleNoteAt) s.idleNoteAt = undefined; // it woke up
      const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
      if (s.idleNoteAt !== undefined) {
        if (t - s.idleNoteAt < limits.graceMs) return;
        s.stopReason ??= 'idle';
        this.addProgress(s, 'status', `still no activity after ${minutes(t - last)} min; stopping the shift`);
        this.flushProgress(s);
        this.log.warn(`shift ${s.msg.shiftId} stopped: no activity for ${minutes(t - last)} min`);
        await s.session.stop('idle');
        return;
      }
      if (t - last < (s.turnDone ? limits.doneMs : limits.turnMs)) return;
      const n = (await s.session.killTools?.()) ?? 0;
      s.idleNoteAt = now();
      this.addProgress(
        s,
        'status',
        `no activity for ${minutes(t - last)} min; ${n > 0 ? 'stopped the running command' : 'no running command found'}`,
      );
      this.flushProgress(s);
    } finally {
      s.idleBusy = false;
    }
  }

  async stopAll(reason: StopReason = 'manager'): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.handleStop(id, reason)));
  }

  onReportResult(msg: ReportResultMsg): void {
    for (const s of this.active.values()) {
      const cb = s.pendingReports.get(msg.reportId);
      if (cb) {
        s.pendingReports.delete(msg.reportId);
        cb({
          accepted: msg.accepted,
          ...(msg.error ? { error: msg.error } : {}),
          ...(msg.message ? { message: msg.message } : {}),
          ...(msg.matches ? { matches: msg.matches } : {}),
          ...(msg.continueShift ? { continueShift: true } : {}),
        });
        return;
      }
    }
  }

  // ------------------------------------------------------------------ internals

  /** The git credentials of a shift: its post-as plan's (app repositories), else this workstation's. */
  private shiftAuth(msg: { postAs?: PostAsPlan | null | undefined }): GitAuth | undefined {
    return this.deps.shiftCredentials?.(msg.postAs).auth ?? this.deps.gitAuth;
  }

  /** Refuses a shift before it starts (the runner's post-as gate): nothing is prepared, the reason goes to the server. */
  refuseStart(shiftId: string, detail: string, opts: { refusedLocally?: boolean } = {}): void {
    if (opts.refusedLocally) {
      this.log.warn(`shift ${shiftId} refused on this workstation: ${detail}`);
      this.deps.transport.send('shift.rejected', {
        shiftId,
        reason: 'internal',
        detail,
        refusedLocally: true,
      });
      return;
    }
    this.reject(shiftId, 'internal', detail);
  }

  private reject(
    shiftId: string,
    reason:
      | 'busy'
      | 'runtime_unavailable'
      | 'repo_missing'
      | 'worktree_failed'
      | 'rebase_conflict'
      | 'environment_not_ready'
      | 'auth_expired'
      | 'usage_limited'
      | 'internal',
    detail?: string,
    conflictedFiles?: string[],
    environment?: { problem: string; detail?: string },
    branchProblem?: { base: string; defaultBranch?: string; branches: string[] },
    limitedUntil?: string,
    accountKey?: string,
    capacity?: ShiftCapacity,
    rebaseError?: RebaseErrorInfo,
  ): void {
    // Every rejection leaves a line here and a reason on the wire: "the runner refused" without either cost a day of
    // searching (backlog #79).
    const why = detail || reason.replaceAll('_', ' ');
    this.log.warn(`shift ${shiftId} rejected (${reason}): ${why}`);
    this.deps.transport.send('shift.rejected', {
      shiftId,
      reason,
      detail: why,
      ...(conflictedFiles ? { conflictedFiles } : {}),
      ...(environment ? { environment } : {}),
      ...(branchProblem ? { branchProblem } : {}),
      ...(limitedUntil ? { limitedUntil } : {}),
      ...(accountKey ? { accountKey } : {}),
      ...(capacity ? { capacity } : {}),
      ...(rebaseError ? { rebaseError } : {}),
    });
  }

  /**
   * Which of the project's declared local test services this shift's sandbox may reach (sandbox/test-services.ts). Empty,
   * without asking the adapter anything, when the server sent none or the shift is not a builder, reviewer or tester card shift.
   */
  private async decideTestServices(
    msg: ShiftStartMsg,
    adapter: RuntimeAdapter | undefined,
    testEnv: ShiftStartMsg['brief']['environment'],
  ): Promise<TestServiceDecision[]> {
    if (!msg.testServices?.length) return [];
    const caps = adapter ? await adapter.capabilities().catch(() => undefined) : undefined;
    const runnerPorts = this.runnerPorts();
    const envForwardPorts =
      testEnv?.mode === 'local' && testEnv.envId && this.deps.runs
        ? this.deps.runs.testPorts(testEnv.envId)
        : new Set<number>();
    return decideTestServices({
      services: msg.testServices,
      kind: msg.kind,
      roleKey: msg.agent.roleKey,
      isDevops: !!msg.agent.isDevops,
      runtime: msg.agent.runtime,
      egressProxy: adapter?.usesEgressProxy?.() === true,
      hasShell: msg.agent.permissions.allowedTools.includes('shell'),
      platform: process.platform,
      sandbox: caps?.sandbox,
      claudeVersion: caps?.version,
      runnerPorts,
      envForwardPorts,
    });
  }

  /** Ports the runner itself owns (its local HTTP port and every port of a run environment): never opened to a sandbox. */
  private runnerPorts(): Set<number> {
    let ipcPort: number | undefined;
    try {
      ipcPort = Number(new URL(this.deps.ipc.url).port) || undefined;
    } catch {
      ipcPort = undefined;
    }
    const runnerPorts = new Set<number>(this.deps.runs?.ownedPorts() ?? []);
    if (ipcPort) runnerPorts.add(ipcPort);
    const wp = this.deps.windowPort?.();
    if (wp) runnerPorts.add(wp);
    return runnerPorts;
  }

  /** Remember what was decided for the project (replaced at every shift start, so a removed entry disappears). */
  private recordTestServices(msg: ShiftStartMsg, decisions: TestServiceDecision[]): void {
    // Only a shift whose role the server tells (builder, reviewer, tester): any other role says nothing about the list.
    if (msg.kind !== 'card' || msg.agent.isDevops || !TEST_SERVICE_ROLES.has(msg.agent.roleKey)) return;
    const key = msg.brief.project.key;
    if (decisions.length === 0) {
      if (!this.testServicesSeen.delete(key)) return;
    } else this.testServicesSeen.set(key, { at: new Date().toISOString(), decisions });
    this.deps.onTestServices?.();
  }

  /** The latest declaration per project, for the status file and the doctor. */
  testServices(): Record<string, TestServicesSeen> {
    return Object.fromEntries(this.testServicesSeen);
  }

  private async run(s: ActiveShift): Promise<void> {
    const { msg } = s;
    const { paths } = this.deps;
    const adapter = this.deps.adapters.get(msg.agent.runtime);
    // The Claude account this shift runs on (absent: main). It was chosen by the server for this shift; a shift that is
    // already running finishes on it, and a resumed one (after a runner restart) stays on it.
    const accountKey = msg.account?.key ?? 'main';
    // A model behind Bedrock, Vertex or a gateway needs no Claude login: the account's login and limits do not gate it.
    const backendModel = splitBackendModel(msg.agent.model) !== null;
    const gate = backendModel ? undefined : adapter?.accountGate?.(accountKey);
    if (gate && gate.state !== 'ok') {
      // Checked before the runtime as a whole: the server learns WHICH account is out. All of these put the card back
      // without penalty. A shift resumed after a restart is not turned away for a limit that appeared meanwhile.
      if (gate.state === 'missing') {
        this.reject(
          msg.shiftId,
          'runtime_unavailable',
          `account_missing:${accountKey}`,
          undefined,
          undefined,
          undefined,
          undefined,
          accountKey,
        );
        return;
      }
      if (!s.resumed) {
        await this.deps.beforeAuthReject?.().catch(() => undefined);
        if (gate.state === 'limited') {
          this.log.warn(
            `shift ${msg.shiftId}: account ${accountKey} is over its usage limit; the shift is put back`,
          );
          this.reject(
            msg.shiftId,
            'usage_limited',
            gate.label,
            undefined,
            undefined,
            undefined,
            gate.limitedUntil,
            accountKey,
          );
        } else {
          this.log.warn(
            `shift ${msg.shiftId}: the login of account ${accountKey} does not work; the shift is put back`,
          );
          this.reject(
            msg.shiftId,
            'auth_expired',
            gate.login === 'none'
              ? `The Claude account ${accountKey} is not signed in on this workstation.`
              : `The Claude login of account ${accountKey} on this workstation has expired.`,
            undefined,
            undefined,
            undefined,
            undefined,
            accountKey,
          );
        }
        return;
      }
    }
    const caps = adapter ? await adapter.capabilities() : undefined;
    if (!adapter || !caps?.available) {
      this.reject(msg.shiftId, 'runtime_unavailable', `runtime ${msg.agent.runtime} is not available`);
      return;
    }
    // A full disk killed a shift in P5-27 (#81) and the card came back every 39 s: refuse up front with a reason the
    // server backs off on. The DevOps engineer is exempt, it is the one who frees the space.
    if (msg.kind !== 'devops') {
      const problem = diskProblem(paths.root, {
        ...(this.deps.diskFree ? { free: this.deps.diskFree } : {}),
        ...(this.deps.diskTmpDir ? { tmpDir: this.deps.diskTmpDir } : {}),
        ...(this.deps.diskLimits?.minTmp !== undefined ? { minTmp: this.deps.diskLimits.minTmp } : {}),
        ...(this.deps.diskLimits?.minData !== undefined ? { minData: this.deps.diskLimits.minData } : {}),
      });
      if (problem) {
        this.log.warn(`shift ${msg.shiftId} not started: ${problem}`);
        this.reject(msg.shiftId, 'worktree_failed', problem);
        return;
      }
    }
    // A login that expired since the last shift: put the card back without penalty now, instead of crashing the first
    // shift on it (the check reads the expiry and only calls Claude when the token is about to expire).
    if (
      !s.resumed &&
      !backendModel &&
      adapter.checkLogin &&
      (await adapter.checkLogin(accountKey).catch(() => 'unknown')) === 'expired'
    ) {
      this.log.warn(
        `shift ${msg.shiftId}: the ${msg.agent.runtime} login has expired; the shift is put back`,
      );
      await this.deps.beforeAuthReject?.().catch(() => undefined);
      this.reject(
        msg.shiftId,
        'auth_expired',
        'The Claude login on this workstation has expired.',
        undefined,
        undefined,
        undefined,
        undefined,
        accountKey,
      );
      return;
    }

    // Every commit of this shift (the agent's, the runner's leftovers commit, merges) carries one identity: the project's
    // "Commit as", else the clone's git config, else the workstation's (backlog #65). With none set a shift that works in
    // a repository is refused, there is no fallback to an agent or product name.
    const identityRepo = msg.worktree ? await this.deps.findRepo(msg.worktree.remoteUrlNormalized) : null;
    // Read-only work never commits: a read-only checkout (planning, design before a dependency lands) and the reviewing
    // roles are not refused for a missing identity (a rebase they need still fails on its own, naming the identity).
    const commits = msg.worktree?.mode !== 'readonly' && !READ_ONLY_ROLES.has(msg.agent.roleKey);
    // With an app selected for this repository the shift runs as the app or not at all (fail closed).
    let identity: Awaited<ReturnType<typeof resolveCommitIdentity>>;
    try {
      identity = await resolveCommitIdentity(
        identityRepo?.localPath ?? paths.root,
        msg.commitAs,
        boundPostAsFor(msg.postAs, msg.worktree?.remoteUrlNormalized, this.deps.appProbe),
      );
    } catch (err) {
      if (!(err instanceof AppIdentityError)) throw err;
      if (commits) {
        this.reject(msg.shiftId, 'internal', appIdentityWire(err));
        return;
      }
      identity = null;
    }
    if (identityRepo && !identity && commits) {
      this.reject(msg.shiftId, 'internal', NO_IDENTITY_WIRE);
      return;
    }
    // A DevOps request about a card whose repository posts as an app (a conflict resolution): every commit of the
    // engineer is the app's, or the request does not run. Other DevOps requests keep today's identity.
    if (msg.kind === 'devops' && msg.agent.isDevops) {
      // the card worktrees as they are now: what this shift changes there is refused and reverted (finding 2)
      s.cardFence = { before: await snapshotCardWorktrees(paths.worktrees), startedAtMs: Date.now() };
      const appIdentity = await devopsRequestIdentity(
        msg.postAs,
        msg.devops?.card?.remoteUrlNormalized,
        paths.root,
        this.deps.appProbe,
      );
      if (typeof appIdentity === 'string') {
        this.reject(msg.shiftId, 'internal', appIdentity);
        return;
      }
      if (appIdentity) identity = appIdentity;
    }
    s.identity = identity;
    const sandbox = await ensureSandbox(
      paths,
      msg.agent.agentId,
      msg.agent.name,
      identity,
      accountKey === 'main' ? undefined : accountKey,
      { log: this.log },
    );
    s.sandbox = sandbox;
    // The DevOps engineer's directory carries a marker, so an unpair can clear it (see unpaired.ts).
    if (msg.agent.isDevops)
      try {
        writeFileSync(join(sandbox.root, DEVOPS_MARKER), '');
      } catch {
        // advisory
      }
    s.releaseTmp = holdAgentTmp(sandbox);
    let cwd = sandbox.scratch;

    if (msg.kind === 'release_prep') {
      const rp = msg.releasePrep;
      if (!rp) {
        this.reject(msg.shiftId, 'internal', 'a release prep shift without its task');
        return;
      }
      if (msg.agent.isDevops && !rp.releaseBranch?.trim()) {
        this.reject(
          msg.shiftId,
          'internal',
          'a release prep shift without its release branch: the DevOps guard cannot protect it, so the shift does not start',
        );
        return;
      }
      const repo = await this.deps.findRepo(rp.remoteUrlNormalized);
      if (!repo) {
        this.reject(msg.shiftId, 'repo_missing', `no local clone for ${rp.remoteUrlNormalized}`);
        return;
      }
      try {
        s.prepTask = await addPrepTaskWorktree(
          repo.localPath,
          rp,
          join(paths.worktrees, `release-prep-${rp.taskId.slice(0, 8)}`),
        );
      } catch (err) {
        this.reject(msg.shiftId, 'worktree_failed', err instanceof Error ? err.message : String(err));
        return;
      }
      cwd = s.prepTask.path;
    } else if (msg.worktree?.mode === 'readonly') {
      const repo = await this.deps.findRepo(msg.worktree.remoteUrlNormalized);
      if (!repo) {
        this.reject(msg.shiftId, 'repo_missing', `no local clone for ${msg.worktree.remoteUrlNormalized}`);
        return;
      }
      const path = `${paths.worktreePath(msg.brief.project.key, msg.brief.card.ref, msg.brief.project.id)}-design`;
      try {
        const co = await ensureReadOnlyCheckout({
          repoPath: repo.localPath,
          baseBranch: msg.worktree.baseBranch,
          path,
          roots: [paths.worktrees],
          auth: this.shiftAuth(msg),
        });
        s.readOnlyCheckout = { path: co.path, repoPath: repo.localPath, baseBranch: msg.worktree.baseBranch };
      } catch (err) {
        this.reject(msg.shiftId, 'worktree_failed', err instanceof Error ? err.message : String(err));
        return;
      }
    } else if (msg.worktree) {
      const repo = await this.deps.findRepo(msg.worktree.remoteUrlNormalized);
      if (!repo) {
        this.reject(msg.shiftId, 'repo_missing', `no local clone for ${msg.worktree.remoteUrlNormalized}`);
        return;
      }
      // An app pushes over https only: an ssh origin is refused now, before any commit is made as the bot.
      const sshRefusal =
        this.deps.shiftCredentials?.(msg.postAs).originRefusal(repo.remoteUrl ?? null) ?? null;
      if (sshRefusal) {
        this.reject(msg.shiftId, 'internal', sshRefusal);
        return;
      }
      // Merge the latest main first: into the working branch before the card branch is cut from it (never for a resumed shift).
      const syncWanted = msg.prepare.syncMain && msg.worktree.mode === 'create' && !s.resumed;
      let sync: SyncMainOutcome | undefined;
      if (syncWanted && msg.prepare.syncMain) {
        const synced = await syncMainIntoWorking({
          repoPath: repo.localPath,
          ...(msg.prepare.syncMain.mainBranch ? { mainBranch: msg.prepare.syncMain.mainBranch } : {}),
          workingBranch: msg.prepare.syncMain.workingBranch,
          ref: msg.brief.card.ref,
          commitAs: msg.commitAs ?? null,
          postAs: boundPostAsFor(msg.postAs, msg.worktree.remoteUrlNormalized, this.deps.appProbe),
          integrationDir: paths.integration,
          ...(this.shiftAuth(msg) ? { auth: this.shiftAuth(msg) } : {}),
        }).catch((err) => {
          // A selected app that cannot mint stops the shift: the merge is never made under another identity.
          if (err instanceof AppIdentityError) return err;
          this.log.warn(`merging the latest main failed for ${msg.brief.card.ref}: ${String(err)}`);
          return undefined;
        });
        if (synced instanceof AppIdentityError) {
          this.reject(msg.shiftId, 'internal', appIdentityWire(synced));
          return;
        }
        sync = synced;
      }
      try {
        s.worktree = await ensureWorktree({
          repoPath: repo.localPath,
          spec: msg.worktree,
          defaultPath: paths.worktreePath(msg.brief.project.key, msg.brief.card.ref, msg.brief.project.id),
          roots: [paths.worktrees],
          auth: this.shiftAuth(msg),
          // Bring the local working branch up to date with the fetch just made (only the project's own working branch).
          ...(this.deps.syncAfterFetch && msg.worktree.baseBranch === msg.brief.project.workingBranch
            ? {
                onFetched: (base: string) =>
                  this.deps.syncAfterFetch?.({
                    repoId: msg.worktree?.repoId as string,
                    remoteUrlNormalized: msg.worktree?.remoteUrlNormalized as string,
                    workingBranch: base,
                  }) ?? Promise.resolve(),
              }
            : {}),
        });
        if (msg.prepare.rebase && !s.resumed)
          s.rebased = ['rebased', 'merged'].includes(
            await rebaseOntoBase(
              s.worktree.path,
              msg.worktree.baseBranch,
              msg.commitAs ?? null,
              boundPostAsFor(msg.postAs, msg.worktree.remoteUrlNormalized, this.deps.appProbe),
              // the fetch before the rebase goes with the app's token when the project posts as one
              msg.postAs ? this.shiftAuth(msg) : undefined,
            ),
          );
        if (sync && s.worktree.created) await this.finishMainSync(s, sync);
        else await this.resumeMainMerge(s);
      } catch (err) {
        if (err instanceof AppIdentityError) {
          this.reject(msg.shiftId, 'internal', appIdentityWire(err));
        } else if (err instanceof RebaseConflictError) {
          this.reject(msg.shiftId, 'rebase_conflict', err.message, err.conflictedFiles);
        } else if (err instanceof RebaseError) {
          // Not a conflict: the existing worktree_failed route (an older server parses it), with git's details.
          this.reject(
            msg.shiftId,
            'worktree_failed',
            err.message,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            err.info,
          );
        } else if (err instanceof BaseBranchMissingError) {
          // uat-runner-fixes-3 finding 5: no commit anywhere is not a wrong branch name: the server asks for a first commit
          const empty =
            err.branches.length === 0 &&
            !(
              await git(repo.localPath, ['for-each-ref', '--count=1', 'refs/heads', 'refs/remotes'])
            ).stdout.trim();
          this.reject(msg.shiftId, 'worktree_failed', err.message, undefined, undefined, {
            ...(empty ? { emptyRepository: true } : {}),
            base: err.base,
            ...(err.defaultBranch ? { defaultBranch: err.defaultBranch } : {}),
            branches: err.branches.slice(0, 200),
            ...(err.createFailed ? { createFailed: err.createFailed } : {}),
          });
        } else if (err instanceof WorktreeError) {
          this.reject(msg.shiftId, 'worktree_failed', err.message);
        } else {
          this.reject(msg.shiftId, 'worktree_failed', err instanceof Error ? err.message : String(err));
        }
        return;
      }
      cwd = s.worktree.path;
      s.releaseWorktree = holdWorktree(cwd, msg.shiftId);
      if (s.worktree.recoveredFrom) {
        const note = `the worktree was left on ${s.worktree.recoveredFrom} (a conflict attempt that did not finish); it was clean and had nothing of its own, so it was switched back to ${s.worktree.branchName}`;
        this.addProgress(s, 'status', note);
        this.log.warn(`${msg.brief.card.ref}: ${note}`);
      }
      s.startSha = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
      s.startedAtMs = Date.now();
      await this.recordBaseTips(s);
      // What was already dirty before the agent started. A resumed shift keeps the snapshot of its first start; one
      // persisted without a snapshot (an older runner) gets none, since by now the worktree holds the agent's own edits.
      if (!s.resumed) s.dirtyAtStart ??= await snapshotDirty(cwd);
      s.branchesAtStart = await snapshotBranches(cwd);
      const seen = await originBranchNames(repo.localPath);
      if (seen.length) s.originBranches = seen;
    }

    // Test environment (spec "Testing strategy"): a tester needs the deployed app and Docker. If not, the server
    // raises a DevOps request for the card and parks it (the shift is rejected, nothing started).
    const testEnv = msg.brief.environment;
    // Any card shift of a stage that needs the project's environment gets it (the tester's `test`, a project's own smoke test).
    const hasEnv = msg.kind === 'card' && !msg.agent.isDevops && !!testEnv;
    if (!s.resumed && !msg.brief.testWithoutEnvironment && (hasEnv || needsTestEnvironment(msg))) {
      if (testEnv?.mode === 'local' && testEnv.envId && this.deps.runs) {
        // The server started this environment for the card (D9): it must be up here, healthy, right now.
        const view = this.deps.runs.testEnvironment(testEnv.envId);
        if (!view || view.state !== 'healthy') {
          const detail = view
            ? `the test environment is ${view.state}`
            : 'this runner does not know the test environment (any more)';
          this.reject(msg.shiftId, 'environment_not_ready', detail, undefined, {
            problem: 'run_failed',
            detail,
          });
          return;
        }
      } else if (testEnv?.mode === 'remote' && testEnv.target) {
        // A deployed target: nothing is started, but it must answer (the sandbox allows exactly its host).
        const why = await (this.deps.probeTarget ?? probeTargetUrl)(testEnv.target.url);
        if (why) {
          this.reject(msg.shiftId, 'environment_not_ready', why, undefined, {
            problem: 'target_unreachable',
            detail: why,
          });
          return;
        }
      } else {
        const check = this.deps.envChecker ?? defaultEnvChecker();
        const problem = await check({ msg, worktree: s.worktree?.path ?? null, paths });
        if (problem) {
          this.reject(msg.shiftId, 'environment_not_ready', problem.detail, undefined, problem);
          return;
        }
      }
    }

    if (!s.resumed) this.deps.transport.send('shift.accepted', { shiftId: msg.shiftId });
    this.persist(s);

    // The card worktree's submodules are filled before the agent starts (after the accept: the server releases a shift
    // that is not accepted within 30 s, and a submodule clone can take minutes). Fresh or reopened, never for a resumed
    // shift; only what is still uninitialised.
    if (msg.kind === 'card' && s.worktree && msg.worktree && !s.resumed) await this.fillWorktreeSubmodules(s);

    // A card worktree this shift just added is prepared before the agent starts: the project's dependencies in the
    // run-step sandbox (the submodule step above is carried into its result).
    if (
      msg.kind === 'card' &&
      s.worktree?.added &&
      !s.resumed &&
      !msg.agent.isDevops &&
      this.deps.config.prepareWorktrees !== false &&
      msg.worktree
    )
      await this.prepareNewWorktree(s, msg.brief.project.projectPath);
    else if (s.submodulesStep)
      s.worktreePrep = { ok: s.submodulesStep.status !== 'failed', steps: [s.submodulesStep] };

    // A suite card's tester: the runner runs the repository's unit suites whole in the background and reports them itself.
    if (msg.kind === 'card' && msg.agent.roleKey === 'tester' && !msg.agent.isDevops)
      this.startRegressionUnits(s);

    // The vaults this shift reads (read-only). A card shift reads every vault the server named (`vaults`; an older server
    // sends only `vault`); question, BA task and CEO shifts read their one `vault`; a DevOps shift reads none.
    const shiftVaults = shiftVaultsOf(msg);
    const vaultCtxs = await readVaultContexts(paths.vaults, shiftVaults);
    // Every vault opens as a read-only folder (secret files blocked, like a reference repository).
    const vaultReadFolder: ReadableFolder[] = vaultCtxs.map((c) => ({
      name: c.kind === 'org' ? 'organization' : 'project',
      path: c.addDir,
      kind: 'vault',
    }));
    // A card shift reads the organization vault only outside the other projects' folders.
    const scopedVaults = cardScopedVaults(msg.kind, vaultCtxs);
    s.brief = withVaultContexts(msg.brief, vaultCtxs);
    // A "run this branch" request: the runner finds BUILD.md and the commits itself (the server never reads repositories).
    if (msg.kind === 'devops' && msg.devops?.run && this.deps.runs) {
      const run = msg.devops.run;
      run.buildDocs = await this.deps.runs.buildDocs(run.envId).catch(() => []);
      const outside = await this.deps.runs.buildGuides(run.envId).catch(() => ({ guides: [], pathMap: [] }));
      run.buildGuides = outside.guides;
      run.pathMap = outside.pathMap;
      const commits = this.deps.runs.sourcesOf(run.envId);
      run.sources = run.sources.map((r) => ({
        ...r,
        commit: commits.find((c) => c.repoId === r.repoId)?.commit ?? r.commit ?? null,
      }));
    }
    // A "Scan with DevOps" request: tell it where the user's checkouts are. They are read-only for it (see `scanDirs`).
    const scanDirs: string[] = [];
    if (msg.kind === 'devops' && msg.devops?.scan) {
      for (const r of msg.devops.scan.repos) {
        const found = await this.deps.findRepo(r.remoteUrlNormalized).catch(() => undefined);
        if (found) {
          r.clonePath = found.localPath;
          scanDirs.push(found.localPath);
        }
      }
    }
    const texts = shiftTexts(msg, s.brief);
    // The skills, playbooks and personas the role lists, as a name-and-description index (`aom skill show <key>` loads one).
    // The project's own skills and subagents (`.agents/skills`, `.claude/skills`, `.claude/agents` of its checkout) join the
    // registry for this project; what changed since the last look is reported so the registry page lists it.
    const registryProject = msg.kind === 'card' ? msg.brief.project.id : undefined;
    if (registryProject && s.worktree && this.deps.capabilities) {
      const r = this.deps.capabilities.indexProject(registryProject, s.worktree.path);
      if (r.changed) this.deps.onProjectCapabilities?.(registryProject, r);
    }
    const capIndex =
      this.deps.capabilities?.instructionsIndex(msg.agent.skills, registryProject, msg.orgId, {
        agentId: msg.agent.agentId,
      }) ?? '';
    if (capIndex) texts.instructions += `\n${capIndex}\n`;
    if (playbookNote(msg.playbookGrants)) texts.instructions += `\n${playbookNote(msg.playbookGrants)}\n`;
    const prepText = prepNote(s.worktreePrep);
    if (prepText) texts.instructions += `\n${prepText}\n`;
    // The skills this agent's role grants, for a runtime with native skills (Claude Code, Codex): written into its private folder.
    const grantedSkills =
      this.deps.capabilities?.grantedSkills(
        msg.agent.skills,
        registryProject,
        msg.orgId,
        { agentId: msg.agent.agentId },
        { packScriptsGated: msg.agent.packScriptsGated === true },
      ) ?? [];
    // The project's reference repositories (read-only), for a card shift and a BA task shift (the server sends repositories
    // there only for a repository-scoping task given to an architect); only clones this runner found itself.
    const registeredFolders =
      msg.kind === 'card' || msg.kind === 'ba_task'
        ? await resolveReadRepos(
            msg.readRepos,
            {
              findRepo: this.deps.findRepo,
              ...(this.deps.findLocal ? { findLocal: this.deps.findLocal } : {}),
              runnerRoot: paths.root,
            },
            msg.localReadRepos,
          )
        : [];
    // A role that reads the organization's code (the architect) also reads every git repository under the organization
    // source folder configured on this runner: read-only, secret files blocked, never the home or data directory.
    const folderRepos =
      msg.kind === 'card' && msg.agent.permissions.readOrgRepos && msg.orgId
        ? await resolveOrgFolderRepos(this.deps.orgSourceFolder?.(msg.orgId), {
            repoRoots: this.deps.config.repoRoots,
            runnerRoot: paths.root,
          })
        : [];
    const readFolders = mergeReadFolders(
      s.readOnlyCheckout
        ? [
            {
              repoId: 'design-checkout',
              name: `${msg.brief.project.name}, working branch ${s.readOnlyCheckout.baseBranch} (no card branch yet)`,
              kind: 'project' as const,
              path: s.readOnlyCheckout.path,
            },
            ...registeredFolders,
          ]
        : registeredFolders,
      folderRepos,
    );
    if (msg.kind === 'card')
      texts.instructions += `\n${renderReadableFolders(mergeReadFolders(readFolders, vaultReadFolder), { workingDir: cwd })}\n`;
    else if (msg.kind === 'ba_task' && registeredFolders.length + vaultReadFolder.length > 0)
      texts.instructions += `\n${renderReadableFolders(mergeReadFolders(registeredFolders, vaultReadFolder), { workingDir: cwd })}\n`;
    else if (vaultReadFolder.length > 0)
      texts.instructions += `\n${renderReadableFolders(vaultReadFolder, { workingDir: cwd })}\n`;
    if (msg.kind === 'card' && msg.worktree && isReadOnlyWorktreeRole(msg.agent.permissions))
      texts.instructions +=
        '\nYour working folder is read-only in this role. A "Read-only file system" error from a write there (files, git add, git commit) is by design, not an environment fault: do not ask DevOps to fix it.\n';
    // The card's attachments, copied read-only next to the shift (outside the worktree) and listed in the instructions.
    const attachDir = cardAttachmentsDir(sandbox.tmp);
    mkdirSync(attachDir, { recursive: true });
    if (msg.kind === 'card' && this.deps.http) {
      const wanted = msg.brief.card.attachments ?? [];
      const synced = await syncCardAttachments({
        dest: attachDir,
        shiftId: msg.shiftId,
        http: this.deps.http,
        items: wanted.map((attachment) => ({ attachment })),
      }).catch((err) => ({ files: [], errors: [String(err)] }));
      for (const e of synced.errors) this.log.warn(`card attachment not copied: ${e}`);
      if (synced.files.length > 0)
        texts.instructions += `\n${renderCardAttachments(attachDir, synced.files)}\n`;
      mkdirSync(attachDir, { recursive: true });
    }
    // The project's code graph: a short, fenced "Graph context" for the card's own words (the holdout arm gets none).
    if (msg.kind === 'card') {
      const card = (s.brief ?? msg.brief).card;
      const section = this.deps
        .graph?.()
        ?.briefSection(msg.graph, { title: card.title, fields: card.fields });
      if (section) {
        texts.instructions += `\n${section}\n`;
        if (s.counter) s.counter.briefBytes = Buffer.byteLength(section);
      }
    }
    if (s.syncMain && msg.kind === 'card') texts.prompt += `\n${mainSyncNote(s.syncMain)}\n`;
    // lean team: the tester runs the E2E specs of the areas the card touches, not the whole suite.
    if (msg.kind === 'card' && msg.brief.e2e) {
      const areas = await e2eAreasSection(msg.brief, s.worktree?.path ?? null).catch(() => undefined);
      if (areas) texts.prompt += `\n${areas.text}\n`;
    }
    const tc = this.deps.toolchains?.resolve();
    if (tc && msg.kind !== 'devops')
      texts.instructions += `\n${toolchainNote(describeToolchains(tc.entries))}\n`;
    const signIn = msg.kind === 'card' ? this.deps.mcpSignInNote?.(msg.mcpServers) : undefined;
    if (signIn) texts.instructions += `\n${signIn}\n`;
    // The tester's environment: where the app is, which suites to run, how to reach it from the sandbox.
    if (hasEnv && testEnv)
      texts.instructions += `\n${environmentNote(testEnv, testEnv.envId ? this.deps.runs?.testEnvironment(testEnv.envId) : null)}\n`;
    // The project's local test services (GWP-41): the loopback ports this shift's sandbox may reach, decided here.
    // A tester's every bash bridges the allowed ones (BASH_ENV, GWP-102); the runner first checks that each answers here.
    const isTester = isTesterShift(msg.kind, msg.agent.roleKey, !!msg.agent.isDevops);
    const testDecisions = await withReachability(
      await this.decideTestServices(msg, adapter, hasEnv ? testEnv : undefined),
      this.deps.probePort,
    );
    const autoBridged = isTester && testServicesSpec(testDecisions) !== '';
    const testNote =
      testServicesNote(testDecisions, { autoBridged }) ||
      (isTester && msg.agent.permissions.allowedTools.includes('shell') ? noTestServicesNote() : '');
    if (testNote) texts.instructions += `\n${testNote}\n`;
    for (const d of testDecisions)
      if (d.state === 'refused') this.addProgress(s, 'status', refusedProgress(d));
      else if (d.answering === false) this.addProgress(s, 'status', notAnsweringLine(d));
    this.recordTestServices(msg, testDecisions);
    // The tester's per-shift E2E scratch: under its own TMPDIR, so inside the write allow-list and swept at shift end.
    const testerEnv = testerShiftEnv({ isTester, autoBridged, tmp: sandbox.tmp, binDir: paths.bin });
    if (testerEnv.AOM_E2E_DIR && testerEnv.AOM_AGENT_TMP_ROOT && testerEnv.PLAYWRIGHT_HTML_OUTPUT_DIR) {
      mkdirSync(testerEnv.AOM_AGENT_TMP_ROOT, { recursive: true, mode: 0o700 });
      mkdirSync(testerEnv.PLAYWRIGHT_HTML_OUTPUT_DIR, { recursive: true });
      texts.instructions += `\n${testerScratchNote(testerEnv.AOM_E2E_DIR)}\n`;
    }
    // Delegation (R3b): only an agent that was granted targets is told about `aom delegate`, and only a Claude Code agent gets
    // native subagents (the same targets, in its own process). The work a child shares with this shift is its working directory.
    s.delegateWork = {
      cwd,
      readDirs: [
        ...readFolders,
        ...(msg.kind === 'ba_task' ? registeredFolders : []),
        ...vaultReadFolder,
      ].map((f) => f.path),
      ...(scopedVaults.length ? { scopedVaults } : {}),
      addDirs: scanDirs,
      ...(tc ? { toolchainReadDirs: tc.readDirs } : {}),
    };
    const subagents = this.mayDelegate(msg)
      ? msg.agent.runtime === 'claude-code'
        ? await this.delegates.nativeSubagents(this.delegateCaller(s))
        : []
      : [];
    const note = this.mayDelegate(msg)
      ? delegateNote(msg.delegation, this.delegates.nativeNames(msg.shiftId))
      : '';
    if (note) texts.instructions += `\n${note}\n`;
    // the agent's name and seniority close the file: everything before is shared by every agent of the role and project
    texts.instructions = identityLast(texts.instructions);
    await adapter.writeInstructions(sandbox, texts.instructions);
    s.credential?.revoke();
    const cred = issueShiftCredential(
      { ipc: this.deps.ipc, runnerRoot: paths.root, log: this.log },
      { sessionId: msg.shiftId, handler: this.handlerFor(s) },
    );
    s.token = cred.token;
    s.credential = cred;
    s.env = {
      ...sandboxEnv(sandbox, undefined, tc?.env, identity),
      ...cred.env,
      ...(s.worktree?.path ? { AOM_WORKDIR: s.worktree.path } : {}),
      // A suite or regression card of a phase follow-up tests the deployed app: Playwright configs read this.
      ...(msg.agent.roleKey === 'tester' && typeof msg.brief.card.fields.targetUrl === 'string'
        ? { AOM_TARGET_URL: msg.brief.card.fields.targetUrl }
        : {}),
      PATH: tc ? agentPath(tc, paths.bin) : `${paths.bin}${delimiter}${process.env.PATH ?? ''}`,
    };
    // The DevOps engineer's raw pushes to app repositories go nowhere (it uses `aom git push --repo`, run here).
    if (msg.kind === 'devops' && msg.agent.isDevops) s.env = withAppPushRefusal(s.env, msg.postAs);
    // A remote target: its address, and the test accounts declared for it as a 0600 file the tester's tools read.
    if (hasEnv && testEnv?.mode === 'remote' && testEnv.target) {
      s.env.AOM_TARGET_URL = testEnv.target.url;
      s.env.AOM_TARGET_NAME = testEnv.target.name;
      if (this.deps.targetSecrets && testEnv.target.secretNames.length > 0) {
        const f = this.deps.targetSecrets.writeFile(
          join(sandbox.tmp, 'env'),
          testEnv.target.id,
          testEnv.target.secretNames,
        );
        if (f.path) s.env.AOM_ENV_SECRETS_FILE = f.path;
        if (f.missing.length > 0)
          this.addProgress(
            s,
            'status',
            `No value is stored on this workstation for the test account setting(s) ${f.missing.join(', ')} of ${testEnv.target.name}.`,
          );
      }
    }
    // The environment's ports reach the tester's sandbox through Unix sockets (`aom-env` bridges them to localhost).
    if (hasEnv && testEnv?.mode === 'local' && testEnv.envId && this.deps.runs) {
      const runs = this.deps.runs;
      const envId = testEnv.envId;
      try {
        s.forwards = await startForwards(sandbox.tmp, [...runs.testPorts(envId)], () =>
          runs.testPorts(envId),
        );
        s.env.AOM_ENV_FORWARDS = s.forwards.spec;
        s.env.AOM_ENV_ID = envId;
      } catch (err) {
        this.log.warn(`could not start the environment forwarders for ${msg.brief.card.ref}: ${String(err)}`);
      }
    }

    // The sandbox opens each allowed test service; `aom-env` bridges a local listener to it (never a bare host).
    const testSpec = testServicesSpec(testDecisions);
    if (testSpec) s.env.AOM_TEST_SERVICES = testSpec;
    // Tester only (GWP-102): every bash sources the bridges, so a plain command reaches the declared ports; E2E scratch.
    Object.assign(s.env, testerEnv);

    // Resume the agent's own earlier session when it may (same agent, under 120K context tokens and 4 hours old).
    let resumeSessionId: string | undefined;
    if (msg.resumeSessionId && !s.resumed) {
      const d = this.sessions.decide(msg.resumeSessionId, msg.agent.agentId, sandbox.configDir, accountKey);
      s.resumeAsked = { sessionId: msg.resumeSessionId, ...d, cwd };
      if (d.state === 'resumed' && this.sessions.get(msg.resumeSessionId)?.runtime === 'codex') {
        // a Codex thread is found by its id in the agent's Codex home, whatever folder the new shift works in
        resumeSessionId = msg.resumeSessionId;
      } else if (d.state === 'resumed') {
        // a group builder moves from one card worktree to the next: its transcript follows it into the new folder
        const how = copySessionTranscript(
          sandbox.configDir,
          msg.resumeSessionId,
          cwd,
          this.sessions.get(msg.resumeSessionId)?.cwd,
        );
        if (how === 'missing') s.resumeAsked = { ...s.resumeAsked, state: 'fresh_transcript_missing' };
        else resumeSessionId = msg.resumeSessionId;
      }
      this.addProgress(
        s,
        'status',
        s.resumeAsked.state === 'resumed'
          ? "continuing this agent's earlier session"
          : `starting a fresh session: ${s.resumeAsked.detail ?? s.resumeAsked.state}`,
      );
    }
    // Short shifts make a few calls and end: the 5 minute prompt cache is cheaper than the 1 hour one (2x the write).
    const shortShift =
      msg.kind === 'question' ||
      msg.kind === 'ceo' ||
      msg.kind === 'devops' ||
      (msg.kind === 'card' && msg.brief.shift.stage === QA_STEPS_STAGE);
    const devopsGuard = devopsGuardFor(msg, s.identity?.email);
    if (guardedShift(msg) && !devopsGuard) {
      this.reject(msg.shiftId, 'internal', 'the DevOps guard could not be configured for this shift');
      return;
    }
    try {
      s.session = await adapter.start({
        shiftId: msg.shiftId,
        prompt: texts.prompt,
        instructionsMarkdown: texts.instructions,
        kind: msg.kind,
        ...(msg.orgId ? { orgId: msg.orgId } : {}),
        ...(shortShift ? { promptCacheTtl: '5m' as const } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(accountKey !== 'main' ? { account: accountKey } : {}),
        ...(devopsGuard ? { devopsGuard } : {}),
        cwd,
        sandbox,
        agent: msg.agent as AgentRuntimeSpec,
        env: s.env,
        grantedSkills,
        addDirs: scanDirs,
        readDirs: [
          ...readFolders,
          ...(msg.kind === 'ba_task' ? registeredFolders : []),
          ...vaultReadFolder,
        ].map((f) => f.path),
        ...(scopedVaults.length ? { scopedVaults } : {}),
        ...(tc ? { toolchainReadDirs: tc.readDirs } : {}),
        // plugin MCP servers: card shifts only (the DevOps engineer, questions and BA tasks keep their behaviour)
        ...(msg.kind === 'card' && msg.mcpServers?.length ? { mcpServers: msg.mcpServers } : {}),
        ...(hasEnv && testEnv?.mode === 'remote' && testEnv.target
          ? { extraAllowedDomains: targetHosts(testEnv.target) }
          : {}),
        ...(testServiceDomains(testDecisions).length
          ? { testServiceDomains: testServiceDomains(testDecisions) }
          : {}),
        ...(subagents.length ? { subagents } : {}),
        maxShiftMinutes: msg.maxShiftMinutes,
        logFile: `${paths.shiftLogs}/${msg.shiftId}.jsonl`,
      });
    } catch (err) {
      this.startFailed(s, err);
      return;
    }
    // Claude Code native subagents: their transcripts are read while the session runs, their rows kept alive, a journal kept
    // for a runner that dies (docs/RUNNER.md, "Native subagents")
    if (subagents.length && s.session)
      this.delegates.attachNative(msg.shiftId, {
        session: s.session,
        configDir: sandbox.configDir,
        sessionId: () => s.runtimeSessionId,
      });

    if (!s.startedSent)
      this.deps.transport.send('shift.started', {
        shiftId: msg.shiftId,
        ...(s.worktree
          ? {
              worktree: {
                path: s.worktree.path,
                branchName: s.worktree.branchName,
                baseBranch: s.worktree.baseBranch,
                created: s.worktree.created,
                headSha: s.startSha ?? s.worktree.headSha,
                ...(s.rebased ? { rebased: true } : {}),
              },
            }
          : {}),
        ...(s.worktree?.createdBranch ? { branchCreated: s.worktree.createdBranch } : {}),
        ...(s.originBranches ? { originBranches: s.originBranches } : {}),
        ...(s.syncMain ? { syncMain: s.syncMain } : {}),
        ...(s.worktreePrep
          ? {
              worktreePrep: {
                ok: s.worktreePrep.ok,
                steps: s.worktreePrep.steps.slice(0, 20).map((x) => ({
                  ...x,
                  ...(x.detail ? { detail: x.detail.slice(0, 1000) } : {}),
                  ms: Math.max(0, Math.round(x.ms)),
                })),
              },
            }
          : {}),
      });
    if (s.worktree?.createdBranch && !s.startedSent) {
      const b = s.worktree.createdBranch;
      this.addProgress(
        s,
        'status',
        `created working branch ${b.base} from ${b.from}${b.pushed ? ' and pushed it' : ''}`,
      );
    }
    if (s.worktree?.branchRecreated && !s.startedSent)
      this.addProgress(
        s,
        'status',
        `branch ${s.worktree.branchName} was gone locally and on origin; recreated it from ${s.worktree.baseBranch}`,
      );
    if (!s.startedSent) {
      s.startedSent = true;
      this.persist(s);
    }
    this.addProgress(
      s,
      'status',
      msg.account && msg.account.key !== 'main'
        ? `shift started on ${msg.agent.runtime}, account ${msg.account.key}`
        : `shift started on ${msg.agent.runtime}`,
    );

    const maxMs = this.deps.maxShiftMsOverride ?? msg.maxShiftMinutes * 60_000;
    const timeout = setTimeout(() => {
      s.stopReason ??= 'timeout';
      void s.session?.stop('timeout');
    }, maxMs);
    const flush = setInterval(() => this.flushProgress(s), this.deps.progressFlushMs ?? 1000);
    const idle: IdleLimits = { ...IDLE_LIMITS, ...this.deps.idle };
    const now = this.deps.idle?.now ?? Date.now;
    s.lastActivity = now();
    const watchdog = setInterval(() => void this.idleCheck(s, idle, now), idle.checkMs);
    watchdog.unref?.();
    if (s.stopReason) void s.session.stop(`stop:${s.stopReason}`); // stop arrived while preparing

    let exit: Extract<RuntimeEvent, { kind: 'exit' }> = { kind: 'exit', code: null };
    let streamDone: () => void = () => {};
    s.streamEnded = new Promise<void>((resolve) => {
      streamDone = resolve;
    });
    // The session's size, now and then: a long shift's growing context is visible on the server before it ends.
    const contextTimer = setInterval(() => this.reportContext(s), this.deps.contextReportMs ?? 120_000);
    contextTimer.unref?.();
    try {
      for await (const ev of s.session.events()) {
        s.lastActivity = now();
        if (ev.kind === 'final') s.turnDone = true;
        else if (ev.kind === 'delta' || ev.kind === 'progress' || ev.kind === 'tool') s.turnDone = false;
        if (ev.kind === 'exit') exit = ev;
        else this.onRuntimeEvent(s, ev);
      }
    } finally {
      clearInterval(watchdog);
      clearTimeout(timeout);
      clearInterval(flush);
      clearInterval(contextTimer);
      streamDone();
    }
    this.flushProgress(s);
    // The agent process never ran (spawn failed): not an agent crash, nothing to collect or roll back.
    if (exit.startFailed && !s.stopReason) {
      this.startFailed(s, new Error(exit.error ?? `could not run ${msg.agent.runtime}`));
      return;
    }

    // Fallback: a fenced aom-report block in the last assistant message.
    if (s.reportState === 'none' && !s.stopReason && s.finalText) {
      const fallback = extractFallbackReport(s.finalText);
      if (fallback) {
        const r = await this.submit(s, fallback);
        this.log.info(
          `fallback aom-report for shift ${msg.shiftId}: ${'accepted' in r && r.accepted ? 'accepted' : 'rejected'}`,
        );
      }
    }
    // A report may still be waiting for the server's verdict.
    while (s.pendingReports.size > 0) await sleep(50);

    // The sandbox's empty mount stubs (.gitmodules, .bashrc, ...) go before anything looks at the worktree, whoever made
    // them (the runner's placeholders or Claude Code itself): never tracked files, never non-empty ones.
    // Not while another shift still works in this worktree (it may be using them as mount points); the last one out
    // clears them. They are empty files, which `sandboxStubNoise` keeps out of every status, guard and commit.
    if (msg.worktree && s.worktree && !otherShiftsUse(s.worktree.path, msg.shiftId))
      await removeSandboxStubs(s.worktree.path).catch(() => []);

    if (msg.worktree && s.worktree && msg.agent.permissions.mayCommit) {
      // A guard rejection leaves the agent's out-of-scope edits in the worktree: discard them, never commit them.
      await discardTestArtifacts(s.worktree.path);
      let holdCommit: string[] = [];
      // (not while a main-branch merge waits for the architect: discarding paths would wreck the merge state)
      if (s.startSha && !(await mergeInProgress(s.worktree.path))) {
        await this.recordBaseTips(s, true);
        const input = this.guardInput(s, s.worktree.path, s.startSha);
        const r = await discardOutOfScope(input);
        if (r.discarded.length > 0)
          this.log.warn(`discarded out-of-scope changes of shift ${msg.shiftId}: ${r.discarded.join(', ')}`);
        if (r.kept.length > 0)
          this.log.warn(
            `kept ${r.kept.length} out-of-scope paths of shift ${msg.shiftId} that are not its own changes: ${r.kept.slice(0, 10).join(', ')}`,
          );
        if (r.skipped) {
          holdCommit = await uncommittedOutOfScope(input);
          const text =
            `The out-of-scope discard was skipped: HEAD moved from ${r.skipped.from.slice(0, 8)} to ${r.skipped.to.slice(0, 8)} ` +
            `outside this shift's commits (a reset, rebase or rewrite of ${s.worktree.branchName}). Nothing was reverted.` +
            (holdCommit.length > 0
              ? ` These out-of-scope files were left uncommitted: ${holdCommit.slice(0, 10).join(', ')}.`
              : '');
          this.log.warn(`${msg.brief.card.ref}: ${text}`);
          await this.submit(s, { kind: 'comment', note: text });
        }
      }
      // A shift that ends without a report but with work in the worktree says so on the card (a denied tool used to
      // end shifts silently, with the work only in the worktree).
      const unreported =
        s.reportState === 'none' && (!s.stopReason || s.stopReason === 'timeout' || s.stopReason === 'idle');
      const leftovers = unreported ? await uncommittedFiles(s.worktree.path) : [];
      const ac: AutoCommitResult | null =
        holdCommit.length > 0 ? null : await this.leftoversCommit(s, 'shift_end');
      const committed = ac?.committed === true;
      if (leftovers.length > 0) {
        const sha = committed
          ? (await git(s.worktree.path, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
          : '';
        const how =
          s.stopReason === 'timeout' || s.stopReason === 'idle'
            ? 'timeout'
            : exit.code !== 0
              ? 'crashed'
              : 'no_report';
        await this.submit(s, {
          kind: 'comment',
          note: unreportedWorkNote(leftovers, {
            outcome: how,
            committed,
            ...(ac?.refused ? { refused: true } : {}),
            ...(sha ? { sha } : {}),
            branch: s.worktree.branchName,
          }),
        });
      }
    }

    // Native subagents this shift ran (Claude Code): booked as delegates of the shift from their transcripts.
    if (s.session?.nativeSubagentUsage)
      await this.delegates
        .bookNative(this.delegateCaller(s), s.session.nativeSubagentUsage())
        .catch((err) =>
          this.log.warn(`could not book the subagents of shift ${msg.shiftId}: ${String(err)}`),
        );

    // A role that may not commit (reviewer, scout, ...) leaves nothing behind, whatever it did to the worktree.
    if (msg.worktree && s.worktree && !msg.agent.permissions.mayCommit && s.startSha) {
      const undone = await resetReadOnlyWorktree({
        worktree: s.worktree.path,
        branchName: s.worktree.branchName,
        startSha: s.startSha,
      });
      if (undone)
        this.log.warn(`rolled back changes a read-only role made in the worktree of shift ${msg.shiftId}`);
    }

    // a DevOps shift that changed a card worktree after its report (or without one): reverted all the same (finding 2),
    // before any early return below (usage limit, expired login: REVIEW B2)
    if (s.cardFence) await this.endCardFence(s);

    // The Claude login does not work: not an agent crash. Whatever the agent left is committed above; the card goes back
    // to the queue without penalty and waits (the runtime is reported expired) until the login works again.
    if (exit.authFailed && s.reportState === 'none' && !s.stopReason) {
      this.log.warn(
        `shift ${msg.shiftId}: the ${msg.agent.runtime} login does not work; the shift is put back`,
      );
      await this.deps.beforeAuthReject?.().catch(() => undefined);
      this.reject(
        msg.shiftId,
        'auth_expired',
        'The Claude login on this workstation has expired.',
        undefined,
        undefined,
        undefined,
        undefined,
        msg.account?.key ?? 'main',
      );
      return;
    }

    // The subscription's usage limit was hit: likewise put back without penalty; the runtime is reported limited until
    // the limit resets, so the server dispatches nothing here meanwhile (backlog #73).
    if (exit.usageLimit && s.reportState === 'none' && !s.stopReason) {
      const until = new Date(exit.usageLimit.until);
      this.log.warn(
        `shift ${msg.shiftId}: the ${msg.agent.runtime} usage limit was reached (resets ${until.toISOString()}); the shift is put back`,
      );
      await this.deps.beforeAuthReject?.().catch(() => undefined);
      this.reject(
        msg.shiftId,
        'usage_limited',
        formatLimitTime(until),
        undefined,
        undefined,
        undefined,
        until.toISOString(),
        msg.account?.key ?? 'main',
      );
      return;
    }

    let outcome: 'reported' | 'no_report' | 'stopped' | 'crashed' | 'timeout';
    if ((s.reportState !== 'none' && s.stopReason !== 'claim_lost') || s.reportAccepted) outcome = 'reported';
    else if (s.stopReason === 'timeout' || s.stopReason === 'idle') outcome = 'timeout';
    else if (s.stopReason) outcome = 'stopped';
    else if (exit.code !== 0) outcome = 'crashed';
    else outcome = 'no_report';

    const contextTokens = s.session.contextTokens?.() ?? 0;
    if (s.runtimeSessionId && contextTokens > 0)
      this.sessions.updateContext(s.runtimeSessionId, contextTokens);
    const endedFrame = this.deps.transport.send('shift.ended', {
      shiftId: msg.shiftId,
      outcome,
      exitCode: exit.code,
      durationMs: Date.now() - s.startedAt.getTime(),
      usage: s.session.usage(),
      ...(contextTokens > 0 ? { contextTokens } : {}),
      ...(s.counter && s.msg.kind === 'card' ? { context: s.counter.snapshot() } : {}),
      ...(s.finalText || exit.error ? { finalText: (s.finalText ?? exit.error ?? '').slice(0, 4000) } : {}),
      guardViolations: s.guardViolations,
    });
    this.deps.onShiftEnded?.(msg.shiftId, typeof endedFrame === 'string' ? endedFrame : undefined);
  }

  /**
   * The runtime could not be started (settings, spawn, E2BIG, ...). Logged with the stack, and reported as a runner
   * rejection ("Shift could not start: <reason>"): the server notes it on the card and puts the card back in the
   * queue, and it does not count as an agent crash (`crashed` outcomes feed the loop breaker and the digests).
   */
  private startFailed(s: ActiveShift, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    this.log.error(
      `shift ${s.msg.shiftId} (${s.msg.brief.card.ref}, ${s.msg.agent.roleKey}) could not start ${s.msg.agent.runtime}: ${reason}`,
      err,
    );
    this.reject(s.msg.shiftId, 'internal', `Shift could not start: ${reason}`.slice(0, 1000));
  }

  private onRuntimeEvent(s: ActiveShift, ev: RuntimeEvent): void {
    if (ev.kind === 'progress') this.addProgress(s, 'text', ev.text);
    else if (ev.kind === 'tool') {
      s.fetched.record(ev.name, ev.summary);
      s.counter?.onTool(ev.id, ev.name, ev.summary);
      this.addProgress(s, 'tool', `${ev.name}: ${ev.summary}`);
    } else if (ev.kind === 'toolresult') s.counter?.onResult(ev.id, ev.bytes);
    else if (ev.kind === 'final') s.finalText = ev.text;
    else if (ev.kind === 'session') this.onSession(s, ev.runtimeSessionId);
  }

  /**
   * Claude's session id: known only once the process printed its first line, after `shift.started` went out. Recorded
   * on this workstation (so a later shift can resume it) and sent as a late update with the context size and, for a
   * shift that was asked to resume, what was decided.
   */
  private onSession(s: ActiveShift, runtimeSessionId: string): void {
    if (s.runtimeSessionId === runtimeSessionId) return;
    s.runtimeSessionId = runtimeSessionId;
    const cwd = s.worktree?.path ?? s.sandbox?.scratch ?? '';
    this.sessions.record({
      sessionId: runtimeSessionId,
      agentId: s.msg.agent.agentId,
      cwd,
      ...(s.msg.account && s.msg.account.key !== 'main' ? { accountKey: s.msg.account.key } : {}),
      ...(s.msg.agent.runtime && s.msg.agent.runtime !== 'claude-code'
        ? { runtime: s.msg.agent.runtime }
        : {}),
      ...(s.resumeAsked?.state === 'resumed' ? { inheritFrom: s.resumeAsked.sessionId } : {}),
    });
    const contextTokens = s.session?.contextTokens?.() ?? 0;
    s.lastContextSent = contextTokens;
    this.deps.transport.send('shift.session', {
      shiftId: s.msg.shiftId,
      runtimeSessionId,
      ...(contextTokens > 0 ? { contextTokens } : {}),
      ...(s.resumeAsked
        ? {
            resume: {
              state: s.resumeAsked.state,
              ...(s.resumeAsked.detail ? { detail: s.resumeAsked.detail } : {}),
            },
          }
        : {}),
    });
  }

  /** Sends the session's context size when it changed (every couple of minutes while the shift runs). */
  private reportContext(s: ActiveShift): void {
    if (!s.runtimeSessionId) return;
    const contextTokens = s.session?.contextTokens?.() ?? 0;
    if (contextTokens <= 0 || contextTokens === s.lastContextSent) return;
    s.lastContextSent = contextTokens;
    this.sessions.updateContext(s.runtimeSessionId, contextTokens);
    this.deps.transport.send('shift.session', {
      shiftId: s.msg.shiftId,
      runtimeSessionId: s.runtimeSessionId,
      contextTokens,
    });
  }

  /** Cumulative usage of the running session every few seconds, for the organization key's monthly cap (best effort). */
  private reportLiveUsage(s: ActiveShift): void {
    if (!this.deps.liveUsage?.() || !s.session) return;
    const now = Date.now();
    if (now - (s.usageSentAt ?? 0) < 5000) return;
    const u = s.session.usage();
    if (!u || u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens <= 0) return;
    s.usageSentAt = now;
    this.deps.transport.send('run.usage', { kind: 'shift', id: s.msg.shiftId, usage: u });
  }

  /**
   * Fills the card worktree's uninitialised submodules at their pinned commits (never throws, never fails the shift).
   * The outcome becomes the `submodules` step of the worktree preparation; each failure is logged and told to the owner
   * with the submodule's path and git's error, credentials redacted.
   */
  private async fillWorktreeSubmodules(s: ActiveShift): Promise<void> {
    const wt = s.worktree;
    if (!wt || !existsSync(join(wt.path, '.gitmodules'))) return;
    this.addProgress(s, 'status', 'filling the submodules');
    this.flushProgress(s);
    const started = Date.now();
    const fill = this.deps.initWorktreeSubmodules ?? initWorktreeSubmodules;
    let fills: Awaited<ReturnType<typeof initWorktreeSubmodules>>;
    try {
      fills = await fill(wt.path, {
        findRepo: this.deps.findRepo,
        ...(this.shiftAuth(s.msg) ? { auth: this.shiftAuth(s.msg) } : {}),
      });
    } catch (err) {
      fills = [{ name: '', path: '', status: 'failed', detail: redactGitError(String(err)) }];
    }
    const ms = Date.now() - started;
    if (fills.length === 0) return;
    const failed = fills.filter((f) => f.status === 'failed');
    for (const f of failed) {
      const what = f.path || f.name || 'submodules';
      this.log.warn(
        `could not fill the submodule ${f.name || what} of ${s.msg.shiftId}: ${f.detail ?? 'failed'}`,
      );
      this.addProgress(s, 'status', `the submodule ${what} could not be filled: ${f.detail ?? 'failed'}`);
    }
    const describe = (f: (typeof fills)[number]) =>
      `${f.path || f.name || 'submodules'}: ${f.detail ?? f.status}`;
    if (failed.length) {
      s.submodulesStep = {
        name: 'submodules',
        status: 'failed',
        detail: failed.map(describe).join('; ').slice(0, 400),
        ms,
      };
    } else if (fills.every((f) => f.status === 'skipped')) {
      s.submodulesStep = {
        name: 'submodules',
        status: 'skipped',
        detail: fills.map(describe).join('; ').slice(0, 400),
        ms,
      };
    } else {
      const skipped = fills.filter((f) => f.status === 'skipped');
      s.submodulesStep = {
        name: 'submodules',
        status: 'done',
        ...(skipped.length
          ? { detail: `not filled: ${skipped.map(describe).join('; ')}`.slice(0, 400) }
          : {}),
        ms,
      };
    }
    this.flushProgress(s);
  }

  /** Prepares the card worktree this shift just added (never throws; a failure is recorded and told to the agent). */
  private async prepareNewWorktree(
    s: ActiveShift,
    projectPath: string | undefined,
    why?: string,
    budgetMs?: number,
  ): Promise<void> {
    const wt = s.worktree;
    if (!wt) return;
    s.prepAbort = new AbortController();
    this.addProgress(
      s,
      'status',
      why
        ? `preparing the worktree's dependencies ${why}`
        : 'preparing the new worktree (submodules, dependencies)',
    );
    this.flushProgress(s); // the owner sees it now, not after the session started
    const runs = this.deps.runs;
    const shiftKey = s.msg.shiftId.slice(0, 8);
    const prep = this.deps.prepareWorktree ?? prepareWorktree;
    try {
      s.worktreePrep = await prep({
        worktree: wt.path,
        ...(projectPath ? { projectPath } : {}),
        ...(runs
          ? {
              launch: (argv: string[], key: string) =>
                runs.checkLaunch({ key: `${shiftKey}-${key}`, worktree: wt.path, argv, network: 'none' }),
            }
          : {}),
        platform: process.platform as Platform,
        signal: s.prepAbort.signal,
        trustLockfile: this.deps.config.prepTrustLockfile !== false,
        ...(budgetMs !== undefined ? { budgetMs } : {}),
        ...(s.submodulesStep ? { submodules: s.submodulesStep } : {}),
      });
    } catch (err) {
      s.worktreePrep = {
        ok: false,
        steps: [{ name: 'prepare', status: 'failed', detail: String(err).slice(0, 400), ms: 0 }],
      };
    } finally {
      s.prepAbort = undefined;
    }
    const r = s.worktreePrep;
    if (r.steps.length === 0) return;
    const secs = Math.round(r.steps.reduce((a, x) => a + x.ms, 0) / 1000);
    const failed = r.steps.filter((x) => x.status === 'failed');
    if (failed.length) {
      const what = failed.map((x) => `${x.name}: ${x.detail ?? 'failed'}`).join('; ');
      this.addProgress(s, 'status', `the worktree was not fully prepared (${what})`);
      this.log.warn(`worktree preparation of ${s.msg.shiftId} failed: ${what}`);
    } else {
      this.addProgress(
        s,
        'status',
        `worktree prepared in ${secs}s (${r.steps.map((x) => x.name).join(', ')})`,
      );
    }
    this.flushProgress(s);
  }

  private addProgress(s: ActiveShift, kind: 'text' | 'tool' | 'status', text: string): void {
    s.progress.push({ at: new Date().toISOString(), kind, text: text.slice(0, 500) });
  }

  private flushProgress(s: ActiveShift): void {
    this.reportLiveUsage(s);
    if (s.progress.length === 0) return;
    const items = s.progress.splice(0, s.progress.length);
    this.deps.transport.send('shift.progress', { shiftId: s.msg.shiftId, items });
  }

  /** Not the CEO's and not the DevOps engineer's shifts: they hold wider powers and never delegate. */
  private scriptGate(shiftId: string) {
    return makePackScriptGate((id, m, p) => this.deps.rpc(id, m, p), shiftId);
  }

  private mayDelegate(msg: ShiftStartMsg): boolean {
    return msg.kind !== 'ceo' && msg.kind !== 'devops' && !msg.agent.isDevops && msg.agent.roleKey !== 'ceo';
  }

  /** The shift as the caller of a delegate: its permissions are the ceiling of every child, its worktree is shared with a working one. */
  private delegateCaller(s: ActiveShift): DelegateCaller {
    const work = s.delegateWork;
    return {
      id: s.msg.shiftId,
      runtime: s.msg.agent.runtime,
      ...(s.msg.brief?.project?.id ? { projectId: s.msg.brief.project.id } : {}),
      ...(s.msg.orgId ? { orgId: s.msg.orgId } : {}),
      viewer: { agentId: s.msg.agent.agentId },
      permissions: s.msg.agent.permissions,
      delegation: s.msg.delegation,
      ...(s.msg.agent.packScriptsGated ? { packScriptsGated: true } : {}),
      ...(work
        ? {
            work: {
              ...work,
              env: {
                ...(s.env?.AOM_WORKDIR ? { AOM_WORKDIR: s.env.AOM_WORKDIR } : {}),
                ...(s.env?.PATH ? { PATH: s.env.PATH } : {}),
              },
            },
            ...(s.identity ? { identity: { name: s.identity.name, email: s.identity.email } } : {}),
          }
        : {}),
    };
  }

  private handlerFor(s: ActiveShift): ShiftIpcHandler {
    return {
      report: async (req: IpcReportRequest) => this.submit(s, req.report),
      rpc: async (req: IpcRpcRequest) => {
        if (req.method === 'skill.show' || req.method === 'skill.list')
          return skillRpc(
            this.deps.capabilities,
            req.method,
            req.params,
            s.msg.brief?.project?.id,
            s.msg.orgId,
            { agentId: s.msg.agent.agentId },
            s.msg.agent.packScriptsGated ? this.scriptGate(s.msg.shiftId) : undefined,
          );
        // `aom delegate`: a sub-task for a granted target. Not for the CEO's and the DevOps engineer's shifts; the server decides
        // (and the runner only knows the targets it was told about at the start).
        if (req.method === DELEGATE_RPC) {
          if (!this.mayDelegate(s.msg))
            return { ok: false, error: '`aom delegate` is not available to this agent' };
          return this.delegates.run(this.delegateCaller(s), req.params);
        }
        // the `Agent` tool's guard hook (Claude Code native subagents)
        if (req.method === 'delegate.guard') {
          if (!this.mayDelegate(s.msg))
            return { ok: false, error: 'subagents are not available to this agent' };
          return this.delegates.guardNative(this.delegateCaller(s), req.params);
        }
        // The runner's own questions to the server about a delegate are not for the agent to ask.
        if (isDelegateServerRpc(req.method)) return { ok: false, error: `${req.method} is not available` };
        // `aom ceo ...` belongs to the CEO's own shifts (the server checks the agent again).
        if (req.method === 'ceo') {
          if (!(s.msg.kind === 'ceo' && s.msg.agent.roleKey === 'ceo'))
            return { ok: false, error: 'not_ceo: only the CEO may use `aom ceo`' } as IpcRpcResponse;
          // `aom ceo route`: read-only, answered here from the organization graph in the organization vault
          if (req.params.op === 'route') return this.orgRoute(s.msg.orgGraph, req.params);
          return this.deps.rpc(s.msg.shiftId, req.method, req.params);
        }
        // `aom runner restart` in a DevOps shift (design 5.6): the restart waits for this shift's end to be acknowledged.
        if (req.method === 'runner.restart') {
          if (s.msg.kind !== 'devops' || !this.deps.onRunnerRestart)
            return {
              ok: false,
              error: '`aom runner restart` is available in the CEO chat and in DevOps shifts only',
            };
          const reason = typeof req.params.reason === 'string' ? req.params.reason.slice(0, 500) : undefined;
          this.deps.onRunnerRestart(s.msg.shiftId, reason);
          return {
            ok: true,
            result: { message: 'Restart scheduled after this shift. Finish your work now.' },
          };
        }
        // A BA task reads a member card of the phase by ref (`aom card <REF>`): the server answers that.
        // A DevOps shift reads its request's card (`aom card show`) through the server, which serves only that card.
        if (req.method === 'card.get' && s.msg.kind === 'devops' && (req.params.ref || req.params.linked))
          return this.deps.rpc(s.msg.shiftId, req.method, req.params);
        if (s.msg.kind === 'ba_task' && s.msg.baTask?.batch && req.method.startsWith('source.'))
          return this.batchSource(s, req.method, req.params);
        if (s.msg.kind === 'ba_task' && s.msg.baTask?.batch && req.method === 'card.attach')
          return this.batchAttach(s, req.params);
        if (req.method === 'card.get' && s.msg.kind === 'ba_task' && req.params.ref)
          return this.deps.rpc(s.msg.shiftId, req.method, req.params);
        if (req.method === 'card.get')
          return { ok: true, result: cardPayload({ ...s.msg, brief: s.brief ?? s.msg.brief }) };
        // `aom graph ...`: answered here from the vault's graph, never by the server (the holdout arm gets none).
        if (req.method.startsWith('graph.')) {
          const g = this.deps.graph?.();
          if (!g)
            return {
              ok: false,
              error: 'the code graph is not available on this workstation',
            } as IpcRpcResponse;
          const r = g.rpc(req.method, req.params, s.msg.graph);
          if (r.ok)
            s.counter?.onGraphVerb(
              Buffer.byteLength(String((r.result as { text?: string } | undefined)?.text ?? '')),
            );
          return r;
        }
        // `aom recipe save` (DevOps): the workstation writes the drafted recipe into the project vault and reports its hash.
        if (req.method === 'recipe.save')
          return s.msg.kind === 'devops' && s.msg.agent.isDevops === true && this.deps.recipeSave
            ? this.deps.recipeSave(s.msg.shiftId, req.params)
            : ({ ok: false, error: 'only the DevOps engineer saves a recipe' } as IpcRpcResponse);
        if (req.method === 'deploy.probe')
          return s.msg.kind === 'devops' && s.msg.agent.isDevops === true && this.deps.deployProbe
            ? this.deps.deployProbe(
                s.msg.shiftId,
                req.params,
                (s.msg.devops?.scan?.deploy?.targets ?? []).map((t) => ({ name: t.name, host: t.host })),
              )
            : ({ ok: false, error: 'only the DevOps engineer probes' } as IpcRpcResponse);
        if (req.method === 'card.attachments') return this.cardAttachments(s, req.params);
        if (req.method === 'transcript.fetch') return this.transcriptFetch(s, req.params);
        if (req.method === DEVOPS_INSTALL_RPC) return this.devopsInstall(s, req.params);
        if (req.method === 'devops.audit')
          return recordDevopsAudit(req.params, {
            isDevops: s.msg.agent.isDevops === true,
            logFile: join(this.deps.paths.logs, 'devops-audit.jsonl'),
            send: (entries) => void this.deps.transport.send('devops.audit', { entries }),
            redact: redactCommand,
          });
        if (req.method.startsWith('run.')) return this.runRpc(s, req.method, req.params);
        if (req.method.startsWith('env.') || req.method === 'test.suite')
          return this.testerRpc(s, req.method, req.params);
        if (req.method.startsWith('toolchain.'))
          return toolchainRpc(
            this.deps.toolchains,
            req.method,
            req.params,
            s.msg.kind === 'devops' && s.msg.agent.isDevops === true,
          );
        if (req.method === 'hygiene.run') return this.hygieneRun(s);
        if (
          (req.method === 'git.push' || req.method === 'git.fetch') &&
          s.msg.kind === 'devops' &&
          s.msg.agent.isDevops === true
        )
          return this.devopsGit(s, req.method, req.params);
        if (
          req.method === 'git.push' ||
          req.method === 'git.fetch' ||
          req.method === 'git.merge_main' ||
          req.method === 'git.verify_merge'
        )
          return this.architectGit(s, req.method, req.params);
        if (req.method === 'git.status' || req.method === 'git.connect') {
          if (s.msg.kind !== 'devops' || !s.msg.agent.isDevops || !this.deps.git)
            return { ok: false, error: 'only the DevOps engineer can use `aom git`' } as IpcRpcResponse;
          return this.deps.git.handle(req.method, req.params);
        }
        return this.deps.rpc(s.msg.shiftId, req.method, req.params);
      },
    };
  }

  private orgRoute(scope: OrgGraphScope | undefined, params: Record<string, unknown>): IpcRpcResponse {
    const q = typeof params.q === 'string' ? params.q : '';
    const drafts = params.drafts === true;
    const text = q.trim() || drafts ? this.deps.graph?.()?.route(scope, q, { drafts }) : null;
    return text
      ? { ok: true, result: { text } }
      : {
          ok: false,
          error:
            'the organization graph is not available on this workstation (it is read where the organization vault is kept)',
        };
  }

  /**
   * Batch intake (#63): `aom source read|attachments|attachment` for the ticket of this shift, with the runner's own
   * ticket credentials (the sandbox has no network). Attachments are limited to that ticket.
   */
  private async batchSource(
    s: ActiveShift,
    method: string,
    params: Record<string, unknown>,
  ): Promise<IpcRpcResponse> {
    const batch = s.msg.baTask?.batch;
    const external = this.deps.external?.();
    if (!batch || !external) return { ok: false, error: 'this runner has no ticket adapters' };
    try {
      if (method === 'source.read') {
        const ref = String(params.ref ?? '').trim();
        if (!ref) return { ok: false, error: 'usage: aom source read --ref <KEY>' };
        return {
          ok: true,
          result: formatSource(
            await external.readText(ref, s.msg.trackerApp ? { app: s.msg.trackerApp } : undefined),
          ),
        };
      }
      if (!s.sandbox) return { ok: false, error: 'this shift has no workspace yet' };
      const deps = {
        jira: () => external.jira,
        scratch: s.sandbox.scratch,
        allowed: batch.system === 'jira' ? [batch.ticketKey.toUpperCase()] : [],
      };
      if (method === 'source.attachments')
        return { ok: true, result: await listJiraAttachments(deps, params.key) };
      if (method === 'source.attachment')
        return {
          ok: true,
          result: await downloadJiraAttachments(
            deps,
            params.key,
            typeof params.name === 'string' ? params.name : undefined,
            params.all === true,
          ),
        };
      return { ok: false, error: `${method} is not available in this task` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** `aom card attach <path> --card <REF>` in a batch intake shift: the BA puts a downloaded file on a card it created. */
  private async batchAttach(s: ActiveShift, params: Record<string, unknown>): Promise<IpcRpcResponse> {
    const sb = s.sandbox;
    const http = this.deps.http;
    if (!sb || !http) return { ok: false, error: 'this runner cannot reach the server for files' };
    try {
      return {
        ok: true,
        result: await attachFileFromAgent({
          path: String(params.path ?? ''),
          ref: typeof params.ref === 'string' && params.ref ? params.ref : undefined,
          roots: [sb.scratch, sb.tmp],
          rpc: (m, p) => this.deps.rpc(s.msg.shiftId, m, p),
          http,
        }),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * `aom run ...`: only the DevOps engineer of a `run` request, only for that request's environment (an `--env` for
   * another one is refused, and without `--env` the shift's own environment is meant).
   */
  private async runRpc(
    s: ActiveShift,
    method: string,
    params: Record<string, unknown>,
  ): Promise<IpcRpcResponse> {
    const run = s.msg.kind === 'devops' ? s.msg.devops?.run : undefined;
    if (!this.deps.runs) return { ok: false, error: 'running a branch is not available on this runner' };
    if (!run || s.msg.kind !== 'devops' || !s.msg.agent.isDevops || !s.msg.devops)
      return { ok: false, error: '`aom run` is only for the DevOps engineer of a "run this branch" request' };
    const asked = typeof params.env === 'string' && params.env ? params.env : run.envId;
    if (asked !== run.envId)
      return { ok: false, error: `this request works environment ${run.envId}, not ${asked}` };
    return this.deps.runs.rpc(run.envId, method, params, {
      requestId: s.msg.devops.requestId,
      declared: run.declared ?? [],
    });
  }

  /**
   * `aom env ...` and `aom test suite` of a tester (docs/design/run-and-integration-tests.md 4.4, 4.6): only the tester
   * of a card, only for the environment this shift was briefed with. The runner answers what it knows (state, ports,
   * logs, restart) and parses reports and logs; the server holds suites and results.
   */
  private async testerRpc(
    s: ActiveShift,
    method: string,
    params: Record<string, unknown>,
  ): Promise<IpcRpcResponse> {
    if (s.msg.kind !== 'card' || s.msg.agent.isDevops)
      return { ok: false, error: '`aom env` and `aom test suite` are for an agent working a card' };
    if (
      method === 'test.suite' &&
      typeof params.name === 'string' &&
      s.regressionUnits?.isUnitSuite(params.name)
    )
      return {
        ok: false,
        error: `"${params.name}" is a unit suite: the runner runs it on this card and reports the result itself. Do not run or report unit tests.`,
      };
    return testerRpc(
      {
        env: s.msg.brief.environment,
        runs: this.deps.runs,
        sandbox: s.sandbox,
        worktree: s.worktree?.path,
        commit: () => this.sourceCommit(s),
        rpc: (m, p) => this.deps.rpc(s.msg.shiftId, m, p),
        http: this.deps.http,
      },
      method,
      params,
    );
  }

  /** The commit of the card's repository in the running environment (shown in the results table). */
  private sourceCommit(s: ActiveShift): string | undefined {
    const envId = s.msg.brief.environment?.envId;
    if (!envId || !this.deps.runs) return undefined;
    const view = this.deps.runs.testEnvironment(envId);
    const own = view?.sources.find((x) => x.repoId === s.msg.worktree?.repoId) ?? view?.sources[0];
    return own?.commit ?? undefined;
  }

  /** `aom card attachments`: copies the attachments of the shift's card again (the server says which ones it may read). */
  private async cardAttachments(s: ActiveShift, params: Record<string, unknown>): Promise<IpcRpcResponse> {
    if (!this.deps.http || !s.sandbox)
      return { ok: false, error: 'attachments are not available on this runner' };
    const listed = await this.deps.rpc(
      s.msg.shiftId,
      'card.attachments',
      params.ref ? { ref: params.ref } : {},
    );
    if (!listed.ok) return listed;
    const cards = (listed.result as { cards: Array<{ ref: string; attachments: BriefAttachment[] }> }).cards;
    const synced = await syncCardAttachments({
      dest: cardAttachmentsDir(s.sandbox.tmp),
      shiftId: s.msg.shiftId,
      http: this.deps.http,
      items: cards.flatMap((c) => c.attachments.map((attachment) => ({ ref: c.ref, attachment }))),
    });
    return { ok: true, result: describeSynced(synced) };
  }

  /** The leftovers commit of a shift: a refusal (mass deletion, tree revert) is logged and noted on the card once. */
  private async leftoversCommit(s: ActiveShift, where: 'shift_end' | 'report'): Promise<AutoCommitResult> {
    const wt = s.worktree;
    if (!wt) return { committed: false, skipped: 'clean' };
    const r = await autoCommit({ worktree: wt.path, ticket: ticketOf(s.msg), env: s.env });
    if (r.refused) {
      const f = r.refused;
      this.log.warn(
        `refused to auto-commit the leftovers of shift ${s.msg.shiftId} (${f.reason}): ${f.deleted} of ${f.tracked} tracked files deleted, ${f.added} added, ${f.modified} modified${f.revertsTo ? `, tree of ${f.revertsTo.slice(0, 8)}` : ''}`,
      );
      const key = `${f.reason}:${f.tree}`;
      if (!s.autoCommitRefusals.has(key)) {
        s.autoCommitRefusals.add(key);
        await this.submit(s, {
          kind: 'comment',
          note: autoCommitRefusedNote(f, { shiftId: s.msg.shiftId, branch: wt.branchName, where }),
        });
      }
    } else if (!r.committed && r.skipped === 'git_failed') {
      this.log.warn(`could not auto-commit the leftovers of shift ${s.msg.shiftId}`);
    }
    return r;
  }

  /** Records the tips of the card's base and working branch (local and origin/): merges of them are base content. */
  private async recordBaseTips(s: ActiveShift, onlyFetched = false): Promise<void> {
    const wt = s.worktree?.path;
    if (!wt) return;
    const branches = new Set(
      [s.worktree?.baseBranch, s.msg.brief.project.workingBranch].filter(
        (b): b is string => !!b && isSafeGitRef(b),
      ),
    );
    let added = false;
    const add = (sha: string | null | undefined): void => {
      if (sha && !s.baseTips.includes(sha)) {
        s.baseTips.push(sha);
        added = true;
      }
    };
    for (const b of branches) {
      if (onlyFetched) {
        // after the start only a runner fetch counts (other shifts of this clone fetch while this one runs): refs the
        // agent can write (refs/heads/<b>, a hand-moved origin/<b>) are not trusted mid-shift
        add(await fetchedRemoteTip(wt, b));
        continue;
      }
      for (const ref of [`refs/remotes/origin/${b}`, `refs/heads/${b}`]) {
        const r = await git(wt, ['rev-parse', '--verify', '--quiet', ref]);
        if (r.exitCode === 0) add(r.stdout.trim());
      }
    }
    if (added) this.persist(s);
  }

  /** The guard's view of this shift: the role's scope plus what the project and the main-branch merges add. */
  private guardInput(s: ActiveShift, worktree: string, startSha: string): GuardInput {
    const { msg } = s;
    const inv = msg.brief.investigation;
    // The architect also writes the project's investigation folder and the card's report path (repository location).
    const extra =
      msg.agent.roleKey === 'architect' && inv && inv.location === 'repo'
        ? [...(inv.folder ? [`${inv.folder}/**`] : []), inv.reportPath]
        : [];
    const protectedBranches = [
      ...new Set(
        [
          msg.prepare.syncMain?.mainBranch ?? msg.worktree?.mainBranch,
          msg.brief.project.workingBranch,
          s.worktree?.baseBranch,
        ].filter((b): b is string => typeof b === 'string' && b.length > 0),
      ),
    ];
    return {
      worktree,
      roleKey: msg.agent.roleKey,
      permissions: msg.agent.permissions,
      cardRef: msg.brief.card.ref,
      projectKey: msg.brief.project.key,
      ...workRefGuardInput(msg.brief.card, msg.brief.project),
      ...(protectedBranches.length ? { protectedBranches } : {}),
      branchName: s.worktree?.branchName ?? '',
      startSha,
      branchesAtStart: s.branchesAtStart,
      e2eGlobs: msg.brief.project.e2eGlobs,
      ...(s.worktree?.baseBranch ? { baseBranch: s.worktree.baseBranch } : {}),
      ...(extra.length ? { extraWritableGlobs: extra } : {}),
      ...(s.mainShas.length ? { mainMergeShas: s.mainShas } : {}),
      ...(s.baseTips.length ? { baseTipShas: s.baseTips } : {}),
      ...(s.startedAtMs ? { startedAtMs: s.startedAtMs } : {}),
      ...(s.dirtyAtStart && Object.keys(s.dirtyAtStart).length ? { dirtyAtStart: s.dirtyAtStart } : {}),
    };
  }

  /**
   * After the card worktree exists: the working branch could not take the latest main, so the card branch does. A
   * conflict is left in the worktree when the architect holds the shift (it resolves it); anyone else gets the merge
   * aborted and the work goes ahead on the working branch as it is.
   */
  private async finishMainSync(s: ActiveShift, sync: SyncMainOutcome): Promise<void> {
    const { msg } = s;
    if (!s.worktree) return;
    if (sync.kind === 'merged_into_working') {
      s.syncMain = { result: 'merged_into_working', commit: sync.commit };
      return;
    }
    if (sync.kind !== 'needs_card_merge') return;
    // what the host refused and the bypass or permission the app needs, for the owner to grant
    if (sync.report) this.log.warn(`${msg.brief.card.ref}: ${sync.report}`);
    const wt = s.worktree.path;
    const main = msg.prepare.syncMain?.mainBranch ?? msg.worktree?.mainBranch;
    const r = await mergeMainIntoCard(wt, {
      ...(main ? { mainBranch: main } : {}),
      ref: msg.brief.card.ref,
      commitAs: msg.commitAs ?? null,
      postAs: boundPostAsFor(msg.postAs, msg.worktree?.remoteUrlNormalized, this.deps.appProbe),
      ...(this.shiftAuth(msg) ? { auth: this.shiftAuth(msg) } : {}),
    });
    if ('error' in r) {
      this.log.warn(`merging the latest main into ${msg.brief.card.ref} failed: ${r.error}`);
      return;
    }
    if (r.result === 'up_to_date') return;
    if (r.result === 'merged_into_card') {
      s.mainShas.push(r.main);
      s.syncMain = { result: 'merged_into_card', commit: r.commit };
      return;
    }
    // A conflict: the architect resolves it in this shift; no one else can.
    if (msg.agent.roleKey === 'architect' && msg.brief.shift.stage.startsWith('investigate')) {
      s.mainShas.push(r.main);
      s.syncMain = { result: 'conflict_in_card', files: r.files };
      return;
    }
    await abortMerge(wt);
    s.syncMain = { result: 'skipped_conflict', files: r.files };
  }

  /**
   * A main-branch merge left unresolved by an earlier architect shift (it ended or timed out before finishing): this shift
   * inherits it, so it is told about the conflict and the guard still exempts what the merge brought in.
   */
  private async resumeMainMerge(s: ActiveShift): Promise<void> {
    const wt = s.worktree?.path;
    if (!wt || !(await mergeInProgress(wt))) return;
    const sha = (await git(wt, ['rev-parse', 'MERGE_HEAD'])).stdout.trim();
    if (sha && !s.mainShas.includes(sha)) s.mainShas.push(sha);
    if (s.msg.agent.roleKey === 'architect' && !s.syncMain) {
      const files = (await git(wt, ['diff', '--name-only', '--diff-filter=U'])).stdout
        .split('\n')
        .filter(Boolean);
      s.syncMain = { result: 'conflict_in_card', files };
    }
  }

  /**
   * `hygiene.run` (the DevOps engineer's `aom hygiene run`): repository hygiene runs here, in the runner, so a
   * repository that posts as an app fetches, pulls and pushes with the app's token (which never reaches the agent) and
   * the commits a pull rewrites get the app as committer. The spec comes from this runner's copy of the brief.
   */
  /** `aom devops install ...`: a card shift's package install, run for it by the DevOps side of the runner. */
  private async devopsInstall(s: ActiveShift, params: Record<string, unknown>): Promise<IpcRpcResponse> {
    if (s.msg.agent.isDevops)
      return { ok: false, error: 'the DevOps engineer runs the package manager itself' };
    if (!s.worktree || !s.msg.worktree)
      return {
        ok: false,
        error:
          '`aom devops install` works in a card shift with a worktree; otherwise ask with `aom devops "<request>"`',
      };
    if (!s.msg.agent.permissions.allowedTools.includes('edit'))
      return { ok: false, error: 'your role does not change the worktree, so it does not install packages' };
    if (!this.deps.devopsInstall)
      return { ok: false, error: '`aom devops install` is not available on this workstation' };
    const parsed = parseDependencyChange(params);
    if (!parsed.ok) return { ok: false, error: parsed.reason };
    return this.deps.devopsInstall({
      shiftId: s.msg.shiftId,
      dir: s.worktree.path,
      repo: s.msg.worktree.remoteUrlNormalized,
      change: parsed.change,
    });
  }

  private async hygieneRun(s: ActiveShift): Promise<IpcRpcResponse> {
    const { msg } = s;
    if (msg.kind !== 'devops' || msg.agent.isDevops !== true)
      return { ok: false, error: 'only the DevOps engineer can run repository hygiene' };
    const spec = msg.devops?.hygiene;
    if (!spec)
      return { ok: false, error: 'this request is not a repository hygiene request: nothing to run' };
    const run = await runHygiene(spec, this.worktreePaths(), {
      changeState: async (q) => {
        try {
          const r = await this.deps.rpc(msg.shiftId, 'hygiene.change_state', q);
          return r.ok ? ((r.result as { state?: 'open' | 'merged' | 'closed' | null }).state ?? null) : null;
        } catch {
          return null;
        }
      },
      ...this.devopsAppAuth(msg.postAs),
      ...(s.identity ? { identity: { name: s.identity.name, email: s.identity.email } } : {}),
    });
    this.addProgress(s, 'status', 'aom hygiene run: done');
    return { ok: true, result: run };
  }

  /** Per-repository app auth of a DevOps shift's plan; empty for a runner without post-as credentials. */
  private devopsAppAuth(plan: PostAsPlan | null | undefined): Pick<HygieneDeps, 'appAuth'> {
    const creds = this.deps.shiftCredentials?.(plan);
    if (!creds?.appFor) return {};
    const appFor = creds.appFor.bind(creds);
    return {
      appAuth: async (url) => {
        const app = appFor(url);
        if (!app) return null;
        const a = await creds.auth(url);
        return { ...a, identity: { name: app.botName, email: app.botEmail } };
      },
    };
  }

  /**
   * `aom git push|fetch --repo <dir>` of the DevOps engineer: the runner talks to origin, so an app repository is
   * reached with the app's token (the agent never sees it), and a repository not on an app with plain git, exactly as
   * the engineer's own `git push` would. No force, no options in refspecs, no delete of a main branch.
   */
  private async devopsGit(
    s: ActiveShift,
    method: string,
    params: Record<string, unknown>,
  ): Promise<IpcRpcResponse> {
    const denied = (error: string): IpcRpcResponse => ({ ok: false, error });
    const repo = typeof params.repo === 'string' ? params.repo : '';
    if (!repo) return denied('usage: aom git push|fetch --repo <dir> [<refspec>...]');
    const dir = resolve(repo);
    const roots = [...(this.deps.config.repoRoots ?? []), this.deps.paths.worktrees, tmpdir()].map((r) =>
      resolve(r),
    );
    if (!roots.some((r) => dir === r || dir.startsWith(`${r}/`)))
      return denied(
        `${repo} is not inside a repository folder, a worktree or the temporary folder of this runner`,
      );
    const refspecs = Array.isArray(params.refspecs)
      ? params.refspecs.filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [];
    const op = method === 'git.push' ? 'push' : 'fetch';
    const plan = devopsPushPlan(
      op,
      refspecs,
      params.delete === true,
      params.tags === true,
      devopsGuardFor(s.msg)?.protectedBranches ?? [],
    );
    if ('error' in plan) return denied(plan.error);
    const url = (await git(dir, ['remote', 'get-url', 'origin'])).stdout.trim();
    if (!url) return denied(`${repo} has no origin`);
    const creds = this.deps.shiftCredentials?.(s.msg.postAs);
    const app = creds?.appFor?.(url) ?? null;
    let auth = { args: [] as string[], env: {} as Record<string, string> };
    if (creds && app) {
      const refusal = creds.originRefusal(url);
      if (refusal) return denied(refusal);
      try {
        auth = await creds.auth(url);
      } catch (err) {
        if (!(err instanceof AppIdentityError)) throw err;
        const entry = postAsFor(s.msg.postAs, normalizeRemoteUrl(url));
        return denied(
          appIdentityWire(
            inContext(err, {
              ...(entry?.projectKey ? { projectKey: entry.projectKey } : {}),
              operation: plan.operation,
              repo: repoNameOf(normalizeRemoteUrl(url)),
            }),
          ),
        );
      }
    }
    const r = await git(dir, [...auth.args, ...plan.args], { env: auth.env });
    this.addProgress(s, 'status', `aom git ${op} --repo ${repo}: ${r.exitCode === 0 ? 'done' : 'failed'}`);
    if (r.exitCode !== 0) return denied(redactGitError(r.stderr || r.stdout || `git ${op} failed`));
    return {
      ok: true,
      result: {
        message: (r.stderr || r.stdout).trim() || `${op} done${app ? ` as the app ${app.label}` : ''}`,
      },
    };
  }

  /** `aom git push|fetch|merge-main|verify-merge`: the architect's runner-run git (investigate stages only). */
  private async architectGit(
    s: ActiveShift,
    method: string,
    params: Record<string, unknown>,
  ): Promise<IpcRpcResponse> {
    const { msg } = s;
    const denied = (error: string): IpcRpcResponse => ({ ok: false, error });
    if (msg.kind !== 'card' || !msg.brief.shift.stage.startsWith('investigate'))
      return denied(
        '`aom git push|fetch|merge-main|verify-merge` are for the architect in the Investigate & design stage',
      );
    if (!s.worktree) return denied('this shift has no card worktree');
    const main = msg.prepare.syncMain?.mainBranch ?? msg.worktree?.mainBranch;
    const ctx = {
      worktree: s.worktree.path,
      branchName: s.worktree.branchName,
      ...(main ? { mainBranch: main } : {}),
      ref: msg.brief.card.ref,
      postAs: boundPostAsFor(msg.postAs, msg.worktree?.remoteUrlNormalized, this.deps.appProbe),
      ...(this.shiftAuth(msg) ? { auth: this.shiftAuth(msg) } : {}),
      recordMainSha: (sha: string) => {
        if (!s.mainShas.includes(sha)) s.mainShas.push(sha);
        this.persist(s);
      },
      startMainSha: () => s.mainShas.at(-1),
    };
    let r: GitReply;
    if (method === 'git.push')
      r = await architectPush(
        ctx,
        typeof params.branch === 'string' && params.branch ? params.branch : undefined,
      );
    else if (method === 'git.fetch') r = await architectFetch(ctx);
    else if (method === 'git.merge_main') r = await architectMergeMain(ctx);
    else r = await architectVerifyMerge(ctx);
    if (r.ok && (method === 'git.fetch' || method === 'git.merge_main')) await this.recordBaseTips(s, true);
    this.addProgress(
      s,
      'status',
      `${method.replace('git.', 'aom git ').replace('_', '-')}: ${r.ok ? 'done' : 'refused'}`,
    );
    return r.ok ? { ok: true, result: { message: r.message } } : denied(r.error);
  }

  /**
   * Checks the architect's report before the card moves on: it exists, has no obvious secret and, in the repository, is
   * committed on the card branch (the commit is attached); in the vault location it is copied into the project's vault.
   */
  private async prepareInvestigation(
    s: ActiveShift,
    data: InvestigationData,
  ): Promise<{ data: InvestigationData } | { error: string }> {
    const { msg } = s;
    const wt = s.worktree?.path;
    const inv = msg.brief.investigation;
    // No card branch yet (the dependencies have not landed): the report is written in the scratch directory.
    const detached = !wt && !!inv?.readOnly;
    if (!wt && !detached) return { error: 'this shift has no card worktree' };
    // The assumption review confirms the recorded design: there is no new report to check.
    if (data.review?.decision === 'confirm' && inv?.review)
      return {
        data: {
          ...data,
          reportPath: inv.report?.reportPath ?? data.reportPath,
          location: inv.report?.location ?? data.location,
        },
      };
    if (detached && !data.assumptions?.length && !data.noAssumptions)
      return {
        error:
          'this design is made before its dependencies landed: record the assumptions you made about them (`--assumption "<assumption> | <dependency ref> | <what changes if wrong>"`, repeatable) or say there are none with `--no-assumptions "<why>"`',
      };
    const location = inv?.location ?? 'repo';
    const asked = data.reportPath.trim();
    const secretsIn = (text: string): string | null => {
      const found = scanReportForSecrets(text);
      return found.length
        ? `the report seems to contain ${found.join(', ')}: remove it (never put secrets or credentials in a report)`
        : null;
    };
    if (location === 'repo' && wt) {
      const rel = asked.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!isValidReportPath(rel) || rel.startsWith('vault:'))
        return { error: `the report path '${asked}' must be a relative path inside the worktree` };
      const abs = resolve(wt, rel);
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        return { error: `the report '${rel}' does not exist: write it, commit it and report again` };
      }
      if (!real.startsWith(`${realpathSync(wt)}/`) || !statSync(real).isFile())
        return { error: `the report '${rel}' must be a file inside the worktree` };
      const reportText = readFileSync(real, 'utf8');
      const leak = secretsIn(reportText);
      if (leak) return { error: leak };
      if ((await git(wt, ['cat-file', '-e', `HEAD:${rel}`])).exitCode !== 0)
        return {
          error: `the report '${rel}' is not committed on the card branch: \`git add\` and commit it, then report again`,
        };
      if ((await git(wt, ['status', '--porcelain', '--', rel])).stdout.trim())
        return { error: `the report '${rel}' has uncommitted changes: commit them, then report again` };
      const commit = (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim();
      return {
        data: {
          reportPath: rel,
          summary: data.summary,
          location: 'repo',
          commit,
          // the design gate shows the full report to the owner (the card branch is not pushed yet)
          reportText: reportText.slice(0, REPORT_TEXT_MAX),
          ...architectFields(data),
        },
      };
    }
    // Vault location: the architect wrote the file under its scratch or temp directory; the runner copies it.
    if (location === 'vault' && (!msg.vault || !this.deps.writeVault))
      return {
        error:
          'there is no knowledge vault for this project, so a vault report cannot be saved: ask the manager to use the repository location',
      };
    const sb = s.sandbox;
    const candidates = isAbsolute(asked)
      ? [asked]
      : [sb ? join(sb.tmp, asked) : '', sb ? join(sb.scratch, asked) : '', wt ? join(wt, asked) : ''].filter(
          Boolean,
        );
    const roots = [sb?.tmp, sb?.scratch, wt].flatMap((r) => (r && existsSync(r) ? [realpathSync(r)] : []));
    let file: string | undefined;
    for (const c of candidates) {
      try {
        const real = realpathSync(c);
        if (statSync(real).isFile() && roots.some((r) => real === r || real.startsWith(`${r}/`))) {
          file = real;
          break;
        }
      } catch {
        // try the next place
      }
    }
    if (!file)
      return {
        error: `the report '${asked}' was not found in your scratch directory ($TMPDIR) or the worktree`,
      };
    const text = readFileSync(file, 'utf8');
    const leak = secretsIn(text);
    if (leak) return { error: leak };
    const rel = inv?.reportPath ?? `${msg.brief.card.ref}.md`;
    if (location === 'repo') {
      // Written before the card branch exists: the text travels with the report and the builder commits it.
      if (!isValidReportPath(rel)) return { error: `the report path '${rel}' is not a valid relative path` };
      return { data: { ...data, reportPath: rel, summary: data.summary, location: 'repo', body: text } };
    }
    if (!msg.vault || !this.deps.writeVault) return { error: 'there is no knowledge vault for this project' };
    const vaultPath = `${msg.vault.folder}/${rel}`;
    try {
      await this.deps.writeVault({
        vaultId: msg.vault.vaultId,
        path: vaultPath,
        mode: 'replace',
        content: text,
        commitMessage: `Investigation: ${msg.brief.card.title}`.slice(0, 120),
        push: true,
      });
    } catch (err) {
      return {
        error: `could not write the report into the vault: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.addProgress(s, 'status', `report saved in the vault: ${vaultPath}`);
    return {
      data: {
        reportPath: vaultPath,
        summary: data.summary,
        location: 'vault',
        ...architectFields(data),
      },
    };
  }

  /**
   * `aom transcript --url <url>`: finds the transcript outside the agent sandbox, writes it into the card's vault
   * (`projects/<name>/transcripts/`), sends the text to the site (for the web pages) and counts the URL as opened.
   */
  private async transcriptFetch(s: ActiveShift, params: Record<string, unknown>): Promise<IpcRpcResponse> {
    const url = typeof params.url === 'string' ? params.url.trim() : '';
    if (!/^https?:\/\//i.test(url))
      return { ok: false, error: '--url must be an http(s) URL' } as IpcRpcResponse;
    const { msg } = s;
    const result: TranscriptResult =
      msg.agent.runtime === 'mock'
        ? mockTranscript(url)
        : await fetchTranscript(url, this.deps.transcript ?? defaultTranscriptDeps());
    let path: string | undefined;
    if (result.status === 'ok' && result.text) {
      if (msg.vault && this.deps.writeVault) {
        const p = transcriptPath(msg.vault.folder, s.startedAt, result.title ?? url, url);
        try {
          await this.deps.writeVault({
            vaultId: msg.vault.vaultId,
            path: p,
            mode: 'replace',
            content: renderTranscriptFile(result, s.startedAt),
            commitMessage: `Transcript: ${result.title ?? url}`.slice(0, 120),
            push: true,
          });
          path = p;
          this.addProgress(s, 'status', `transcript saved ${p}`);
        } catch (err) {
          this.addProgress(
            s,
            'status',
            `transcript not saved to the vault: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // The site keeps the text for the web pages; the vault file is the durable copy.
      await this.deps
        .rpc(msg.shiftId, 'transcript.store', {
          url,
          title: result.title ?? url,
          ...(result.language ? { language: result.language } : {}),
          ...(result.autoGenerated !== undefined ? { autoGenerated: result.autoGenerated } : {}),
          ...(path ? { vaultPath: path } : {}),
          text: result.text,
          truncated: result.truncated ?? false,
        })
        .catch(() => undefined);
      // A transcript fetched here counts as opening the source (research citations, feed items).
      s.fetched.add(url);
    }
    s.transcripts.set(normalizeUrl(url), {
      ref: refOf(result, path),
      title: result.title ?? url,
    });
    return {
      ok: true,
      result: { status: result.status, path, message: renderTranscriptMessage(result, path) },
    } as IpcRpcResponse;
  }

  /** `aom publish`: checks the note (citations, opened sources, path), writes it into the card's vault and commits it. */
  private async publishNote(
    s: ActiveShift,
    request: PublishRequest,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
    const { msg } = s;
    if (!msg.vault)
      return {
        ok: false,
        error:
          'there is no knowledge vault for this project (register the organization vault or a project vault in Settings, Vaults), so the note cannot be published',
      };
    if (!this.deps.writeVault) return { ok: false, error: 'this runner cannot write into a vault' };
    const sub = msg.brief.card.fields.subCategory;
    const prepared = preparePublication({
      request,
      folder: msg.vault.folder,
      card: {
        ref: msg.brief.card.ref,
        ...(typeof sub === 'string' && sub.trim() ? { subCategory: sub.trim() } : {}),
      },
      fetched: s.fetched,
      transcripts: new Map(
        [...s.transcripts].flatMap(([k, v]) =>
          v.ref.path ? [[k, { path: v.ref.path, title: v.title }]] : [],
        ),
      ),
      at: s.startedAt,
    });
    if (!prepared.ok) return prepared;
    try {
      const w = await this.deps.writeVault({
        vaultId: msg.vault.vaultId,
        path: prepared.path,
        mode: 'create',
        content: prepared.content,
        commitMessage: `Research: ${prepared.publication.title}`.slice(0, 120),
        push: true,
      });
      this.addProgress(
        s,
        'status',
        `published ${prepared.path}${w.paused ? ' (vault sync paused: it is pushed once the conflict is resolved)' : ''}`,
      );
    } catch (err) {
      return {
        ok: false,
        error: `could not write the note into the vault: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { ok: true, data: prepared.publication as unknown as Record<string, unknown> };
  }

  /** Sets `transcript` on every video or podcast candidate from the lookups of this shift; rejects when one was skipped. */
  private attachTranscripts(
    s: ActiveShift,
    data: Record<string, unknown>,
  ): { data: Record<string, unknown> } | { error: string } {
    const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
    const missing: string[] = [];
    const next = items.map((i) => {
      const { transcript: _agentWrote, ...rest } = i;
      if (typeof i.kind !== 'string' || typeof i.url !== 'string' || !hasTranscript(i.kind)) return rest;
      const t = s.transcripts.get(normalizeUrl(i.url));
      if (!t) {
        missing.push(i.url);
        return rest;
      }
      return { ...rest, transcript: t.ref };
    });
    if (missing.length > 0)
      return {
        error: `these video/podcast candidates have no transcript lookup: ${missing.join(', ')}. Run \`aom transcript --url <url>\` for each (it reports "no transcript available" when there is none), or leave the item out.`,
      };
    return { data: { ...data, items: next } };
  }

  /**
   * Proposes `check` suites (and, when the server asks, `unit` suites) from what the card's repository declares (once per
   * repository: the server says when).
   */
  private async proposeChecks(s: ActiveShift, cb: NonNullable<ShiftBrief['checks']>): Promise<void> {
    try {
      if (!s.worktree) return;
      const base = await baseRef(s.worktree.path, s.worktree.baseBranch);
      const projectPath = s.msg.brief.project.projectPath ?? '.';
      const suites = [
        ...(cb.detect ? await detectChecksFromRef(s.worktree.path, base, projectPath) : []),
        ...(cb.detectUnits ? await detectUnitSuitesFromRef(s.worktree.path, base) : []),
      ].slice(0, 10);
      if (suites.length === 0) return;
      const r = await this.deps.rpc(s.msg.shiftId, 'env.suites.propose', { suites });
      if (!r.ok) this.log.warn(`check proposal for shift ${s.msg.shiftId} refused: ${r.error ?? 'unknown'}`);
    } catch (err) {
      this.log.warn(`check proposal for shift ${s.msg.shiftId} failed`, err);
    }
  }

  /**
   * The handoff checks of a builder, tester or writer success handoff (docs/RUNNER.md "Handoff checks"): the confirmed
   * checks over the whole repository at the committed head, and a builder's unit test runs. Anything but passed, deferred
   * or regression_only refuses the handoff; the refusal is also posted on the card (once per distinct text in a shift).
   */
  private async handoffChecks(
    s: ActiveShift,
    data: string | undefined,
    toSend: ShiftReport,
    attach: Record<string, unknown>,
    cb: NonNullable<ShiftBrief['checks']>,
  ): Promise<{ refused: string } | { attach: Record<string, unknown>; summary: string }> {
    const { msg } = s;
    const wt = s.worktree;
    if (wt && (cb.detect || cb.detectUnits)) void this.proposeChecks(s, cb);
    const units = msg.agent.roleKey === 'builder' ? (cb.units ?? []) : [];
    if (cb.suites.length === 0 && units.length === 0) return { attach, summary: '' };
    if (!wt || !s.startSha)
      return {
        refused:
          'the project has confirmed handoff checks, but this shift has no card worktree or start commit on this workstation, so they cannot run and nothing was handed on. Ask with `aom question --topic environment`, quoting this.',
      };
    // The whole handoff (dependency refresh, checks, unit runs) has one deadline, so that with the server's verdict wait
    // it ends inside the agent's command wait (docs/RUNNER.md "Handoff checks", time bound).
    const startedAt = Date.now();
    if (data === 'buildHandoff') {
      // do not run minutes of checks for a refusal the server would give anyway
      const problem = buildEvidenceProblem(
        BuildHandoffDataSchema.parse(toSend.kind === 'outcome' ? toSend.data : {}).buildEvidence,
      );
      if (problem) return { refused: problem };
    }
    if (s.checksRunning)
      return {
        refused: 'the checks of an earlier `aom handoff` are still running: wait for that command to finish',
      };
    // The checks judge the committed tree: a tester's or writer's leftovers are committed first, as a builder's are.
    if (data !== 'buildHandoff' && data !== 'diffStats' && msg.agent.permissions.mayCommit) {
      const ac = await this.leftoversCommit(s, 'report');
      if (ac.refused) return { refused: refusedReport(ac.refused) };
    }
    const headSha =
      typeof attach.headSha === 'string' ? attach.headSha : await gitOk(wt.path, ['rev-parse', 'HEAD']);
    const changedPaths = Array.isArray(attach.changedPaths)
      ? (attach.changedPaths as string[])
      : (await computeCardDiff(wt.path, wt.baseBranch)).changedPaths;
    s.checksRunning = true;
    s.checkAbort ??= new AbortController();
    s.checkCache ??= new Map();
    const tmps: string[] = [];
    let r: Awaited<ReturnType<typeof runHandoffChecks>>;
    try {
      // A worktree whose dependencies were never prepared (an in-flight card, a reused worktree): prepared once, offline.
      await this.refreshDependencies(s, Math.min(HANDOFF_PREP_BUDGET_MS, HANDOFF_WORK_BUDGET_MS));
      const runs = this.deps.runs;
      const gi = this.guardInput(s, wt.path, s.startSha);
      const role = msg.agent.roleKey;
      // A builder's unit runs reach the declared local test services through the runner's forwarders (GWP-248)
      const checkSvc = units.length
        ? decideCheckServices({
            services: msg.testServices,
            kind: msg.kind,
            roleKey: role,
            isDevops: !!msg.agent.isDevops,
            platform: process.platform,
            runnerPorts: this.runnerPorts(),
          })
        : [];
      const svcAllowed = allowedServices(checkSvc);
      let svcProbed = false;
      r = await runHandoffChecks({
        suites: cb.suites,
        units,
        worktree: wt.path,
        changedPaths,
        headSha,
        logDir: join(s.sandbox?.scratch ?? join(tmpdir(), 'aom-checks'), 'checks'),
        signal: s.checkAbort.signal,
        cache: s.checkCache,
        ...(this.deps.checksBudgetMs ? { budgetMs: this.deps.checksBudgetMs } : {}),
        totalBudgetMs: Math.max(0, HANDOFF_WORK_BUDGET_MS - (Date.now() - startedAt)),
        scope: {
          mayEdit: (p) => mayEdit(gi, p),
          ownerOf: (p) => ownerOf(msg.brief.project.e2eGlobs, p),
          defer: role === 'builder',
          ...(role === 'tester'
            ? {
                reportHint:
                  'Report a product code finding with `aom test fail` (it files a bug card for a builder); at the Build stage ask with `aom question --topic code`.',
              }
            : role === 'writer'
              ? { reportHint: 'Ask with `aom question --topic code`, quoting the findings.' }
              : {}),
        },
        ...(runs
          ? {
              launch: async (argv: string[], key: string, opts: { unit: boolean }) => {
                if (opts.unit && svcAllowed.length && !svcProbed) {
                  // informational only: the verdict comes from the run itself
                  svcProbed = true;
                  for (const d of await withReachability(checkSvc))
                    if (d.state === 'allowed' && d.answering === false)
                      this.addProgress(s, 'status', notAnsweringLine(d));
                }
                const l = await runs.checkLaunch({
                  key: `${msg.shiftId.slice(0, 8)}-${key}`,
                  worktree: wt.path,
                  argv,
                  network: 'none',
                  ...(opts.unit ? { services: svcAllowed, runId: checkRunId(msg.shiftId, headSha) } : {}),
                });
                tmps.push(l.tmp);
                return opts.unit && checkSvc.length ? { ...l, services: checkSvc } : l;
              },
            }
          : {}),
      });
    } finally {
      s.checksRunning = false;
      for (const t of tmps) rmSync(t, { recursive: true, force: true });
    }
    if ((await gitOk(wt.path, ['rev-parse', 'HEAD'])) !== headSha)
      return { refused: 'the branch moved while the checks ran: commit, then run `aom handoff` again' };
    if (r.blocking.length) {
      this.postRefusal(s, r.refusal, r.evidence, headSha);
      return { refused: r.refusal };
    }
    return {
      attach: {
        ...attach,
        headSha: attach.headSha ?? headSha,
        checks: r.evidence,
        checksPolicy: CHECKS_POLICY,
      },
      summary: r.summary,
    };
  }

  /**
   * A refused handoff's checks go to the server as a card comment carrying the results (stored, shown on the card, and
   * counted for the desk alert). Not sent again for the same refusal text in this shift. Fire and forget.
   */
  private postRefusal(s: ActiveShift, refusal: string, checks: CheckEvidence[], headSha: string): void {
    const hash = createHash('sha256').update(refusal).digest('hex').slice(0, 16);
    if (s.lastRefusalHash === hash) return;
    s.lastRefusalHash = hash;
    const blocking = checks.filter((c) => !checkStatusPasses(c.status));
    const note = `The handoff checks refused this handoff at ${headSha.slice(0, 10)}: ${blocking
      .map((c) => `${c.kind === 'unit' ? 'unit tests ' : ''}"${c.name}" ${c.status} (${c.summary})`)
      .join('; ')}`.slice(0, 4000);
    this.deps.transport.send('shift.report', {
      shiftId: s.msg.shiftId,
      reportId: uuidv7(),
      report: { kind: 'comment', note },
      checks,
      headSha,
      checksPolicy: CHECKS_POLICY,
    });
  }

  /**
   * Starts a suite card's unit suites (`brief.regressionUnits`) in the background: whole, one after the other, in the
   * run-step sandbox with the host network (reviewed code on the working branch; a suite may reach a local database) and
   * the offline package-manager environment. Each result goes to the server as the runner's measurement.
   */
  private startRegressionUnits(s: ActiveShift): void {
    const suites = s.msg.brief.regressionUnits ?? [];
    const wt = s.worktree;
    const runs = this.deps.runs;
    if (!suites.length || !wt || s.regressionUnits) return;
    s.checkAbort ??= new AbortController();
    const tmps: string[] = [];
    const key = s.msg.shiftId.slice(0, 8);
    s.regressionUnits = new RegressionUnits({
      suites,
      worktree: wt.path,
      logDir: join(s.sandbox?.scratch ?? join(tmpdir(), 'aom-checks'), 'checks'),
      signal: s.checkAbort.signal,
      launch: async (argv, k) => {
        if (!runs) throw new Error('this runner cannot run unit suites');
        const l = await runs.checkLaunch({ key: `${key}-${k}`, worktree: wt.path, argv, network: 'host' });
        tmps.push(l.tmp);
        return l;
      },
      report: async (r) => {
        const res = await this.deps.rpc(s.msg.shiftId, 'test.suite', { ...r });
        if (!res.ok)
          this.log.warn(`unit suite ${r.name} of ${s.msg.brief.card.ref}: ${res.error ?? 'refused'}`);
        this.addProgress(s, 'status', `unit suite ${r.name}: ${r.status}`);
      },
    });
    this.addProgress(
      s,
      'status',
      `running the unit suites ${suites.map((x) => x.name).join(', ')} in the background`,
    );
    void s.regressionUnits
      .start()
      .catch((err) => this.log.warn(`unit suites of ${s.msg.brief.card.ref} failed`, err))
      .finally(() => {
        for (const t of tmps) rmSync(t, { recursive: true, force: true });
      });
  }

  /** Prepares a worktree whose dependencies were never prepared, once per shift, before the checks (offline, no network). */
  private async refreshDependencies(s: ActiveShift, budgetMs: number): Promise<void> {
    if (s.depsRefreshed || !s.worktree || s.msg.agent.isDevops) return;
    if (this.deps.config.prepareWorktrees === false) return;
    const prepared = s.worktreePrep?.steps.some(
      (x) => x.status === 'done' && x.name !== 'submodules' && x.name !== 'restore changed files',
    );
    if (prepared) {
      s.depsRefreshed = true;
      return;
    }
    await this.prepareNewWorktree(s, s.msg.brief.project.projectPath, 'before the handoff checks', budgetMs);
    // a refresh cut off or failed is tried again at the next handoff (each try is bounded by `budgetMs`)
    if (s.worktreePrep?.ok) s.depsRefreshed = true;
  }

  /**
   * uat-runner-fixes-3 finding 2: compares the card worktrees with the DevOps shift's start, reverts what it changed and
   * records the violation (sent with `shift.ended`). Returns the refusal for the agent, or null when nothing changed.
   */
  private async checkCardFence(s: ActiveShift): Promise<string | null> {
    const fence = s.cardFence;
    if (!fence) return null;
    const findings = await enforceCardFence({
      root: this.deps.paths.worktrees,
      before: fence.before,
      shiftId: s.msg.shiftId,
      ...(s.msg.kind === 'devops' && s.msg.devops?.conflictCard
        ? { conflictBranch: s.msg.devops.conflictCard.branch }
        : {}),
      usedByOthers: (p) => usedSince(p, fence.startedAtMs),
    });
    if (findings.length === 0) return null;
    const v = fenceViolation(findings);
    if (!s.guardViolations.some((x) => x.rule === v.rule && x.detail === v.detail)) s.guardViolations.push(v);
    this.log.warn(`shift ${s.msg.shiftId.slice(0, 8)}: ${v.detail}`);
    // the next comparison starts from the reverted state
    fence.before = await snapshotCardWorktrees(this.deps.paths.worktrees);
    return `${v.detail}. Report again with what you did NOT do and why: the card's builder asks for a package with \`aom devops install\` from its own shift.`;
  }

  /** The last card worktree check of a DevOps shift (its end, whichever way it ends). */
  private async endCardFence(s: ActiveShift): Promise<void> {
    if (!s.cardFence || s.cardFence.ended) return;
    s.cardFence.ended = true;
    await this.checkCardFence(s);
  }

  /** Validates, guards, attaches runner data, sends `shift.report` and waits for the server's verdict. */
  private async submit(
    s: ActiveShift,
    report: ShiftReport,
  ): Promise<IpcReportResponse | { status: number; error: string }> {
    const { msg } = s;
    const terminal = isTerminalReport(report);
    if (terminal && s.reportState !== 'none') {
      return {
        accepted: false,
        message: 'A terminal report was already recorded for this shift.',
        error: 'already reported',
      };
    }

    // The DevOps engineer never changes a card worktree: refused and reverted before the report goes anywhere (finding 2)
    if (terminal && s.cardFence) {
      const fenced = await this.checkCardFence(s);
      if (fenced) return rejected(fenced);
    }

    let attach: Record<string, unknown> = {};
    let checkNote = '';
    let toSend: ShiftReport = report;
    if (report.kind === 'outcome') {
      const outcome = msg.brief.shift.outcomes.find((o) => o.id === report.outcomeId);
      if (!outcome) {
        const allowed = msg.brief.shift.outcomes.map((o) => o.id).join(', ');
        return rejected(
          `Unknown outcome "${report.outcomeId}" for the ${msg.brief.shift.stageLabel} stage. Allowed: ${allowed}.`,
        );
      }
      const parsed = outcomeDataSchema(outcome.data).safeParse(report.data);
      if (!parsed.success) {
        return rejected(
          `Invalid data for outcome "${outcome.id}" (${outcome.data}): ${parsed.error.message}`,
        );
      }
      toSend = { ...report, data: parsed.data as Record<string, unknown> };

      // A suite card's unit suites are the runner's measurement: no pass while one runs or failed; a failure report gets a
      // bug section per failing test file (the server files one bug card each, a rerun's same failure is seen again).
      if (s.regressionUnits && outcome.data === 'testEvidence') {
        if (outcome.kind === 'success') {
          const problem = s.regressionUnits.passProblem();
          if (problem) return rejected(problem);
        } else {
          const sections = s.regressionUnits.failSections();
          if (sections)
            toSend = { ...toSend, note: `${report.note.trimEnd()}\n\n${sections}`.slice(0, 20000) };
        }
      }

      // A release prep task: the runner checks the files against the task and keeps them as a local commit; a refusal
      // reaches the server as the task's failure (the agent cannot work around it by reporting again). A proposal task
      // (changelog entries, guide edits) is checked first and a refusal goes back to the agent, who fixes it in this shift.
      if (msg.kind === 'release_prep' && msg.releasePrep && s.prepTask && outcome.id === PREP_OUTCOME.done) {
        if (PREP_TASK_KINDS[msg.releasePrep.task.kind].result === 'proposal') {
          const checked = await finishPrepProposal(s.prepTask, msg.releasePrep);
          if (!checked.ok)
            return rejected(
              `The proposal was not accepted. Fix these and run aom prep done again:\n${checked.findings.map((f) => `- ${f}`).join('\n')}`,
            );
          toSend = { ...toSend, data: { ...toSend.data, proposal: checked.proposal, files: [] } };
        } else {
          const done = await finishPrepTask(
            s.prepTask,
            msg.releasePrep,
            msg.commitAs,
            boundPostAsFor(msg.postAs, msg.releasePrep.remoteUrlNormalized, this.deps.appProbe),
          );
          toSend = done.ok
            ? { ...toSend, data: { ...toSend.data, commit: done.commit, files: done.files } }
            : {
                kind: 'outcome',
                outcomeId: PREP_OUTCOME.failed,
                note: done.reason,
                data: { reason: done.reason, refused: true },
              };
        }
      }

      // Transcripts (videos and podcasts): the scout must have looked each one up; the runner attaches the reference.
      if (outcome.data === 'candidates') {
        const filled = this.attachTranscripts(s, toSend.data);
        if ('error' in filled) return rejected(filled.error);
        toSend = { ...toSend, data: filled.data };
      }

      // No fabrication: scouts and curators may only report pages that were opened during this shift (feeds, M5).
      const unopened = checkFeedItemsFetched({
        dataKind: outcome.data,
        data: toSend.data,
        fetched: s.fetched,
        vouched: msg.brief.feed?.candidates.map((c) => c.url) ?? [],
      });
      if (unopened) return rejected(unopened);

      // Research (M6): the checker's note is written into the vault by the runner; the server only hears the path
      // and the citations.
      if (outcome.data === 'publication' && isPublishRequest(toSend.data)) {
        const published = await this.publishNote(s, toSend.data as unknown as PublishRequest);
        if (!published.ok) return rejected(published.error);
        toSend = { ...report, data: published.data };
      }

      if (!s.worktree && outcome.kind === 'success' && outcome.data === 'investigation') {
        const prepared = await this.prepareInvestigation(s, toSend.data as unknown as InvestigationData);
        if ('error' in prepared) return rejected(prepared.error);
        toSend = { ...toSend, data: prepared.data as unknown as Record<string, unknown> };
      }

      if (s.worktree && s.startSha) {
        await this.recordBaseTips(s, true);
        // A submodule left off its pin (agent sandboxes cannot run `git submodule update`) goes back to the pin before
        // the guard and the leftovers commit: a role that commits is judged on every changed path, so the drift would
        // refuse a tester it cannot fix, and `git add -A` would commit it as a pin change. Not during a merge.
        if (msg.agent.permissions.mayCommit && !(await mergeInProgress(s.worktree.path))) {
          // (never a fetch: this runs on the host, on content the agent can write)
          const drift = await resetSubmoduleDrift(s.worktree.path);
          if (drift.reset.length) {
            const note = submoduleResetNote(drift.reset);
            this.log.info(`${msg.brief.card.ref}: ${note}`);
            await this.submit(s, { kind: 'comment', note });
            checkNote = note;
          }
          if (drift.refused) return rejected(drift.refused);
        }
        const violations = await runGuard(this.guardInput(s, s.worktree.path, s.startSha));
        if (violations.length > 0) {
          for (const v of violations) {
            if (!s.guardViolations.some((x) => x.rule === v.rule && x.detail === v.detail))
              s.guardViolations.push(v);
          }
          return {
            accepted: false,
            message: 'Report rejected by the post-shift guard.',
            error: violations.map((v) => `${v.rule}: ${v.detail}`).join('; '),
            guardViolations: violations,
          };
        }
        if (outcome.kind === 'success' && outcome.data === 'investigation') {
          // The report must be committed on the card branch (or copied into the vault) before the card moves on.
          if (msg.agent.permissions.mayCommit) {
            const ac = await this.leftoversCommit(s, 'report');
            if (ac.refused) return rejected(refusedReport(ac.refused));
          }
          const prepared = await this.prepareInvestigation(s, toSend.data as unknown as InvestigationData);
          if ('error' in prepared) return rejected(prepared.error);
          toSend = { ...toSend, data: prepared.data as unknown as Record<string, unknown> };
        }
        if (outcome.kind === 'success' && (outcome.data === 'diffStats' || outcome.data === 'buildHandoff')) {
          if (msg.agent.permissions.mayCommit) {
            const ac = await this.leftoversCommit(s, 'report');
            if (ac.refused) return rejected(refusedReport(ac.refused));
          }
          const stats = await computeDiffStats({
            worktree: s.worktree.path,
            baseBranch: s.worktree.baseBranch,
            architecturalGlobs: msg.brief.project.architecturalGlobs,
          });
          attach = { diffStats: stats, riskTier: riskTier(stats, msg.brief.card.cardType) };
          // lean team: the commit the evidence is bound to, the changed paths (the server computes the high-risk flag from
          // them) and the diff for the owner approval. Measured after the autocommit above, by the runner, never by the agent.
          if (outcome.data === 'buildHandoff') {
            const cd = await computeCardDiff(s.worktree.path, s.worktree.baseBranch);
            attach = { ...attach, headSha: cd.headSha, changedPaths: cd.changedPaths, diff: cd.diff };
          }
        }
      }
      // The handoff checks (lint, format, typecheck over the whole repository, and a builder's unit test runs) run on this
      // commit, by the runner, for every success handoff of a builder, tester or writer, and for any role's build handoff
      // (a custom role at a build stage): anything but a pass refuses it here, and the refusal is posted on the card.
      // Outside the worktree block on purpose: a shift without a worktree or start commit is refused, never let through.
      const cb = msg.brief.checks;
      if (
        outcome.kind === 'success' &&
        cb &&
        (isHandoffCheckRole(msg.agent.roleKey) || outcome.data === 'buildHandoff') &&
        !msg.agent.isDevops
      ) {
        const checked = await this.handoffChecks(s, outcome.data, toSend, attach, cb);
        if ('refused' in checked) return rejected(checked.refused);
        attach = checked.attach;
        if (checked.summary) checkNote = checkNote ? `${checkNote} ${checked.summary}` : checked.summary;
      }
    }

    // Reviewers must report the adversarial review's risk call (backlog #70); other roles never send one.
    // (The pre-review does not rate the risk, also when a reviewer covers it.)
    if (
      report.kind === 'outcome' &&
      msg.agent.roleKey === 'reviewer' &&
      msg.brief.shift.stage !== 'pre_review'
    ) {
      const reviewOutcome = msg.brief.shift.outcomes.find((o) => o.id === report.outcomeId);
      const d = (toSend as { data: Record<string, unknown> }).data as {
        risk?: string;
        riskAnalysis?: string;
      };
      if (reviewOutcome?.data === 'review' && (!d.risk || !d.riskAnalysis?.trim()))
        return rejected(
          'A review needs your risk call: add `--risk low|medium|high` and `--risk-file <your risk analysis markdown>` (blast radius, failure scenarios, verified, unverified, mitigations), and `--qa-focus "<what a person should test>"` for a medium or high risk. Run the command again.',
        );
    }

    const reportId = uuidv7();
    if (terminal) s.reportState = 'pending';
    let settleTerminal: () => void = () => undefined;
    if (terminal) s.terminalVerdict = new Promise<void>((r) => (settleTerminal = r));
    const verdict = new Promise<ReportVerdict | 'timeout'>((resolve) => {
      // The verdict is applied right here, not after the await below: the server's stop can arrive in the same
      // socket read and must already see the accepted report.
      s.pendingReports.set(reportId, (v) => {
        if (terminal) this.applyTerminalVerdict(s, v);
        settleTerminal();
        resolve(v);
      });
      setTimeout(() => {
        if (s.pendingReports.delete(reportId)) {
          settleTerminal();
          resolve('timeout');
        }
      }, this.deps.reportWaitMs ?? 120_000).unref?.();
    });
    if (
      msg.agent.isDevops &&
      toSend.kind === 'outcome' &&
      (toSend as { outcomeId?: string }).outcomeId === 'devops_approval'
    )
      try {
        this.deps.onDevopsApproval?.(
          msg,
          ((toSend as { data?: unknown }).data ?? {}) as Record<string, unknown>,
        );
      } catch {
        // advisory: the server raises the Desk item either way
      }
    this.deps.transport.send('shift.report', { shiftId: msg.shiftId, reportId, report: toSend, ...attach });
    const result = await verdict;

    if (result === 'timeout') {
      // Persisted in the outbox: it will be delivered when the server is reachable.
      return { accepted: true, message: `Queued. ${ACCEPTED_MESSAGE}` };
    }
    if (!result.accepted) return rejected(result.error ?? 'the server rejected the report', result.matches);
    return {
      accepted: true,
      message: `${result.message ?? (terminal ? ACCEPTED_MESSAGE : 'Recorded.')}${checkNote ? ` ${checkNote}` : ''}`,
      ...(result.matches ? { matches: result.matches } : {}),
    };
  }

  /** What a terminal report's verdict does to the shift; runs when the verdict arrives. */
  private applyTerminalVerdict(s: ActiveShift, v: ReportVerdict): void {
    if (!v.accepted || v.continueShift) {
      // Rejected, or a builder's test question under "Test without an environment": the shift goes on and may still hand off.
      s.reportState = 'none';
      return;
    }
    s.reportState = 'accepted';
    s.reportAccepted = true;
    s.graceTimer = setTimeout(
      () => void s.session?.stop('report_accepted'),
      this.deps.exitGraceMs ?? 120_000,
    );
    s.graceTimer.unref?.();
  }
}

/**
 * The architect's own fields of a design report, copied into the data the runner forwards. The body, commit and report
 * text are runner-owned and are not taken from the agent.
 */
function architectFields(data: InvestigationData): Partial<InvestigationData> {
  return {
    ...(data.assumptions ? { assumptions: data.assumptions } : {}),
    ...(data.noAssumptions ? { noAssumptions: data.noAssumptions } : {}),
    ...(data.review ? { review: data.review } : {}),
    ...(data.size ? { size: data.size } : {}),
    ...(data.testsOnly ? { testsOnly: true } : {}),
  };
}

/** The note the architect's prompt gets about the merge of the latest main branch. */
function mainSyncNote(sync: NonNullable<ActiveShift['syncMain']>): string {
  switch (sync.result) {
    case 'conflict_in_card':
      return [
        '## A merge of the main branch is waiting in your worktree',
        `Merging the latest main branch into this card conflicts in: ${(sync.files ?? []).join(', ')}.`,
        'Resolve it first: fix the conflicted files so both sides keep their intent (no behaviour change), `git add` them, `git commit --no-edit`, then `aom git verify-merge`. Your report is refused while the merge is unfinished.',
      ].join('\n');
    case 'merged_into_working':
      return '## Main branch\nThe latest main branch was merged into the working branch (and pushed) before this card branch was cut from it.';
    case 'merged_into_card':
      return '## Main branch\nThe working branch could not take the latest main branch directly, so it was merged into this card branch.';
    case 'skipped_conflict':
      return '## Main branch\nThe latest main branch conflicts with the working branch; it was not merged.';
  }
}

const refusedReport = (f: Parameters<typeof describeRefusal>[0]): string =>
  `The runner did not commit your pending changes as Work in progress: ${describeRefusal(f)}. Nothing in the worktree was changed. If the deletion is intended, commit it yourself with a message that says why, then report again. If it is not, restore the files from HEAD and report again. If you did not make these changes, ask with aom question.`;

const rejected = (error: string, matches?: LedgerMatch[]): IpcReportResponse => ({
  accepted: false,
  message: `Report rejected: ${error}`,
  error,
  ...(matches ? { matches } : {}),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Finds a valid terminal ```aom-report {json}``` block in the last assistant text. */
export function extractFallbackReport(text: string): ShiftReport | null {
  const re = /```aom-report\s*([\s\S]*?)```/g;
  let last: string | undefined;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
  if (!last) return null;
  try {
    const parsed = ShiftReportSchema.safeParse(JSON.parse(last));
    return parsed.success && isTerminalReport(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}
