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
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import {
  type AgentRuntimeSpec,
  type BriefAttachment,
  type GuardViolation,
  hasTranscript,
  type InvestigationData,
  type IpcReportRequest,
  type IpcReportResponse,
  type IpcRpcRequest,
  type IpcRpcResponse,
  isPublishRequest,
  isTerminalReport,
  isValidReportPath,
  type LedgerMatch,
  normalizeUrl,
  outcomeDataSchema,
  type PublishRequest,
  type ReadableFolder,
  type RepoReport,
  renderCardAttachments,
  renderReadableFolders,
  type ServerToRunnerOf,
  type ShiftBrief,
  type ShiftReport,
  ShiftReportSchema,
  scanReportForSecrets,
  type TranscriptRef,
  type Usage,
  uuidv7,
  type VaultWriteCommand,
} from '@aom/shared';
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
import type { RunnerConfig } from '../config.ts';
import type { Outbox } from '../connection/outbox.ts';
import { cardPayload, shiftTexts } from '../devops/requests.ts';
import { type ExternalAdapters, formatSource } from '../external/index.ts';
import { checkFeedItemsFetched, FetchedUrls } from '../feeds/validation.ts';
import {
  architectFetch,
  architectMergeMain,
  architectPush,
  architectVerifyMerge,
  type GitReply,
} from '../git/architect-git.ts';
import { computeDiffStats, riskTier } from '../git/diffstat.ts';
import { git, originBranchNames } from '../git/git.ts';
import { NO_IDENTITY_WIRE, resolveCommitIdentity } from '../git/identity.ts';
import {
  abortMerge,
  mergeInProgress,
  mergeMainIntoCard,
  type SyncMainOutcome,
  syncMainIntoWorking,
} from '../git/sync-main.ts';
import {
  BaseBranchMissingError,
  ensureWorktree,
  type GitAuth,
  RebaseConflictError,
  rebaseOntoBase,
  WorktreeError,
  type WorktreeResult,
} from '../git/worktrees.ts';
import type { IpcServer, ShiftIpcHandler } from '../ipc/server.ts';
import { type Logger, nullLogger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import { mergeReadFolders, resolveOrgFolderRepos, resolveReadRepos } from '../read-repos.ts';
import { preparePublication } from '../research/publish.ts';
import type { RunManager } from '../runs/manager.ts';
import { ensureSandbox, type Sandbox, sandboxEnv } from '../sandbox/sandbox.ts';
import { defaultEnvChecker, type EnvChecker, needsTestEnvironment } from '../testing/environment.ts';
import {
  agentPath,
  describeToolchains,
  type ToolchainRegistry,
  toolchainNote,
  toolchainRpc,
} from '../toolchain/registry.ts';
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
import { readVaultContext, withVaultContext } from '../vaults/context.ts';
import { autoCommit, uncommittedFiles, unreportedWorkNote } from './autocommit.ts';
import {
  type BranchSnapshot,
  discardOutOfScope,
  discardTestArtifacts,
  type GuardInput,
  resetReadOnlyWorktree,
  runGuard,
  snapshotBranches,
} from './guard.ts';

type ShiftStartMsg = ServerToRunnerOf<'shift.start'>;
type ReportResultMsg = ServerToRunnerOf<'shift.report.result'>;
type StopReason = ServerToRunnerOf<'shift.stop'>['reason'];

export interface ShiftTransport {
  /** Acked types are persisted and retried; best-effort types are dropped while offline. */
  send(type: string, payload: Record<string, unknown>): string;
}

export interface SupervisorDeps {
  paths: RunnerPaths;
  config: RunnerConfig;
  adapters: Map<string, RuntimeAdapter>;
  ipc: IpcServer;
  transport: ShiftTransport;
  outbox: Outbox;
  log?: Logger;
  /** Finds the local clone for a normalized remote URL. */
  findRepo: (remoteUrlNormalized: string) => Promise<RepoReport | undefined>;
  /** This workstation's clone by catalog key (path relative to a repoRoot): reference repositories picked on this workstation. */
  findLocal?: (localKey: string) => Promise<{ localPath: string } | undefined>;
  /** The runner's HTTP calls to the server (attachment bytes). Absent: attachments are not copied. */
  http?: ServerHttp;
  /** Forwards an rpc to the server (`rpc.request`). */
  rpc: (shiftId: string, method: string, params: Record<string, unknown>) => Promise<IpcRpcResponse>;
  /** Writes (and commits, pushes) a file into a vault clone: `aom publish` puts research notes there (M6). */
  writeVault?: (
    cmd: VaultWriteCommand,
  ) => Promise<{ written: boolean; committed: boolean; pushed: boolean; paused: boolean }>;
  maxConcurrentShifts?: () => number;
  /** Runs before a shift is put back for an expired login: the runner tells the server the runtime is paused first. */
  beforeAuthReject?: () => Promise<void>;
  /** Text for the agent's instructions about granted MCP servers that need a sign-in here (empty: none). */
  mcpSignInNote?: (granted: readonly string[] | undefined) => string;
  /** Test/dev override of `maxShiftMinutes` (milliseconds). */
  maxShiftMsOverride?: number;
  /** How long a report waits for `shift.report.result` before being treated as queued. Default 120 s. */
  reportWaitMs?: number;
  /** How long the session may linger after an accepted report. Default 2 min. */
  exitGraceMs?: number;
  progressFlushMs?: number;
  /** Tester environment check before the session starts (default: Docker and the deployed app). */
  envChecker?: EnvChecker;
  /** How `aom transcript` reaches yt-dlp and the web (default: the real ones; tests inject fakes). */
  transcript?: TranscriptDeps;
  /** `aom sudo`: runs a command with administrator rights for the DevOps engineer (the stored sudo password stays here). */
  sudoRun?: (cmd: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** `aom git status|connect` for the DevOps engineer (the runner drives the login on this workstation). */
  git?: { handle(method: string, params: Record<string, unknown>): Promise<IpcRpcResponse> };
  /** The ticket systems of this workstation: a batch intake shift reads its ticket (`aom source read`) like an intake chat. */
  external?: () => ExternalAdapters | undefined;
  /** Credentials for pushing a working branch the runner creates (absent: the user's own git setup). */
  gitAuth?: GitAuth;
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
}

/** The server's answer to a `shift.report`: what the agent is told (and any ledger matches for a question). */
interface ReportVerdict {
  accepted: boolean;
  error?: string;
  message?: string;
  matches?: LedgerMatch[];
}

/** The tracker ticket key the card came from (`DCPL-4276`), the only reference that may appear in a commit message. */
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const ticketOf = (msg: ShiftStartMsg): string | null => {
  const k = msg.brief.card.fields.externalRef;
  return typeof k === 'string' && TICKET_KEY.test(k.trim()) ? k.trim() : null;
};

interface ActiveShift {
  msg: ShiftStartMsg;
  startedAt: Date;
  token?: string;
  session?: RuntimeSession;
  worktree?: WorktreeResult;
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
  /** Resumed after a runner restart: the server already holds the claim and has seen accepted/started. */
  resumed?: boolean;
  startedSent?: boolean;
  sandbox?: Sandbox;
  /** The commit identity resolved for this shift (project setting, repository, workstation); null when none is set. */
  identity?: { name: string; email: string; source: string } | null;
  /** What the "merge latest main first" step did (reported with `shift.started`). */
  syncMain?: { result: NonNullable<ShiftStartedSyncMain['result']>; commit?: string; files?: string[] };
  /** `origin/<main>` SHAs merged into the card branch this shift: the guard exempts what those merges brought in. */
  mainShas: string[];
}

type ShiftStartedSyncMain = {
  result: 'merged_into_working' | 'merged_into_card' | 'conflict_in_card' | 'skipped_conflict';
};

/** On-disk record of a running shift (`<dataDir>/active-shifts/<shiftId>.json`). */
interface PersistedShift {
  msg: ShiftStartMsg;
  startedSent: boolean;
  mainShas?: string[];
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

const ACCEPTED_MESSAGE = 'Recorded. Finish now; do not make further changes.';

export class ShiftSupervisor {
  private readonly active = new Map<string, ActiveShift>();
  private readonly log: Logger;

  constructor(private readonly deps: SupervisorDeps) {
    this.log = deps.log ?? nullLogger;
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

  /** Worktree paths of the shifts that are running or starting (the stale-worktree sweep leaves them alone). */
  worktreePaths(): string[] {
    const out: string[] = [];
    for (const s of this.active.values()) {
      if (s.worktree) out.push(s.worktree.path);
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
  async handleStart(
    msg: ShiftStartMsg,
    resume?: { startedSent: boolean; mainShas?: string[] },
  ): Promise<void> {
    if (this.active.has(msg.shiftId)) return; // redelivery
    const max = this.deps.maxConcurrentShifts?.() ?? this.deps.config.maxConcurrentShifts;
    if (this.active.size >= max) {
      this.reject(msg.shiftId, 'busy', `${this.active.size} shifts already running`);
      return;
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
      env: {},
      mainShas: resume?.mainShas ? [...resume.mainShas] : [],
      ...(resume ? { resumed: true, startedSent: resume.startedSent } : {}),
    };
    this.active.set(msg.shiftId, shift);
    try {
      await this.run(shift);
    } catch (err) {
      this.log.error(`shift ${msg.shiftId} failed unexpectedly`, err);
      if (!shift.session)
        this.reject(msg.shiftId, 'internal', err instanceof Error ? err.message : String(err));
    } finally {
      if (shift.token) this.deps.ipc.revoke(shift.token);
      if (shift.graceTimer) clearTimeout(shift.graceTimer);
      this.active.delete(msg.shiftId);
      this.forget(msg.shiftId);
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
        });
      } catch (err) {
        this.log.warn(`ignoring unreadable persisted shift ${f}: ${String(err)}`);
        rmSync(join(this.deps.paths.activeShifts, f), { force: true });
      }
    }
  }

  private persist(s: ActiveShift): void {
    try {
      mkdirSync(this.deps.paths.activeShifts, { recursive: true });
      const file = join(this.deps.paths.activeShifts, `${s.msg.shiftId}.json`);
      const rec: PersistedShift = {
        msg: s.msg,
        startedSent: !!s.startedSent,
        ...(s.mainShas.length ? { mainShas: s.mainShas } : {}),
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
    s.stopReason ??= reason;
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
        });
        return;
      }
    }
  }

  // ------------------------------------------------------------------ internals

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
      | 'internal',
    detail?: string,
    conflictedFiles?: string[],
    environment?: { problem: string; detail?: string },
    branchProblem?: { base: string; defaultBranch?: string; branches: string[] },
  ): void {
    this.deps.transport.send('shift.rejected', {
      shiftId,
      reason,
      ...(detail ? { detail } : {}),
      ...(conflictedFiles ? { conflictedFiles } : {}),
      ...(environment ? { environment } : {}),
      ...(branchProblem ? { branchProblem } : {}),
    });
  }

  private async run(s: ActiveShift): Promise<void> {
    const { msg } = s;
    const { paths } = this.deps;
    const adapter = this.deps.adapters.get(msg.agent.runtime);
    const caps = adapter ? await adapter.capabilities() : undefined;
    if (!adapter || !caps?.available) {
      this.reject(msg.shiftId, 'runtime_unavailable', `runtime ${msg.agent.runtime} is not available`);
      return;
    }

    // Every commit of this shift (the agent's, the runner's leftovers commit, merges) carries one identity: the project's
    // "Commit as", else the clone's git config, else the workstation's (backlog #65). With none set a shift that works in
    // a repository is refused, there is no fallback to an agent or product name.
    const identityRepo = msg.worktree ? await this.deps.findRepo(msg.worktree.remoteUrlNormalized) : null;
    const identity = await resolveCommitIdentity(identityRepo?.localPath ?? paths.root, msg.commitAs);
    if (identityRepo && !identity) {
      this.reject(msg.shiftId, 'internal', NO_IDENTITY_WIRE);
      return;
    }
    s.identity = identity;
    const sandbox = await ensureSandbox(paths, msg.agent.agentId, msg.agent.name, identity);
    s.sandbox = sandbox;
    let cwd = sandbox.scratch;

    if (msg.worktree) {
      const repo = await this.deps.findRepo(msg.worktree.remoteUrlNormalized);
      if (!repo) {
        this.reject(msg.shiftId, 'repo_missing', `no local clone for ${msg.worktree.remoteUrlNormalized}`);
        return;
      }
      // Merge the latest main first: into the working branch before the card branch is cut from it (never for a resumed shift).
      const syncWanted = msg.prepare.syncMain && msg.worktree.mode === 'create' && !s.resumed;
      let sync: SyncMainOutcome | undefined;
      if (syncWanted && msg.prepare.syncMain) {
        sync = await syncMainIntoWorking({
          repoPath: repo.localPath,
          ...(msg.prepare.syncMain.mainBranch ? { mainBranch: msg.prepare.syncMain.mainBranch } : {}),
          workingBranch: msg.prepare.syncMain.workingBranch,
          ref: msg.brief.card.ref,
          commitAs: msg.commitAs ?? null,
          integrationDir: paths.integration,
          ...(this.deps.gitAuth ? { auth: this.deps.gitAuth } : {}),
        }).catch((err) => {
          this.log.warn(`merging the latest main failed for ${msg.brief.card.ref}: ${String(err)}`);
          return undefined;
        });
      }
      try {
        s.worktree = await ensureWorktree({
          repoPath: repo.localPath,
          spec: msg.worktree,
          defaultPath: paths.worktreePath(msg.brief.project.key, msg.brief.card.ref, msg.brief.project.id),
          roots: [paths.worktrees],
          auth: this.deps.gitAuth,
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
          await rebaseOntoBase(s.worktree.path, msg.worktree.baseBranch, msg.commitAs ?? null);
        if (sync && s.worktree.created) await this.finishMainSync(s, sync);
        else await this.resumeMainMerge(s);
      } catch (err) {
        if (err instanceof RebaseConflictError) {
          this.reject(msg.shiftId, 'rebase_conflict', err.message, err.conflictedFiles);
        } else if (err instanceof BaseBranchMissingError) {
          this.reject(msg.shiftId, 'worktree_failed', err.message, undefined, undefined, {
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
      s.startSha = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
      s.branchesAtStart = await snapshotBranches(cwd);
      const seen = await originBranchNames(repo.localPath);
      if (seen.length) s.originBranches = seen;
    }

    // Test environment (spec "Testing strategy"): a tester needs the deployed app and Docker. If not, the server
    // raises a DevOps request for the card and parks it (the shift is rejected, nothing started).
    if (!s.resumed && needsTestEnvironment(msg)) {
      const check = this.deps.envChecker ?? defaultEnvChecker();
      const problem = await check({ msg, worktree: s.worktree?.path ?? null, paths });
      if (problem) {
        this.reject(msg.shiftId, 'environment_not_ready', problem.detail, undefined, problem);
        return;
      }
    }

    if (!s.resumed) this.deps.transport.send('shift.accepted', { shiftId: msg.shiftId });
    this.persist(s);

    // A card, question or BA task shift reads only the vault the server named for it; a DevOps shift reads none.
    const vaultCtx =
      (msg.kind === 'card' || msg.kind === 'question' || msg.kind === 'ba_task' || msg.kind === 'ceo') &&
      msg.vault
        ? await readVaultContext(paths.vaults, msg.vault)
        : null;
    // Question and BA task shifts open the vault as a read-only folder (secret files blocked, like a reference repository).
    const vaultReadFolder: ReadableFolder[] =
      vaultCtx && msg.kind !== 'card'
        ? [
            {
              name: msg.vault?.kind === 'org' ? 'organization' : 'project',
              path: vaultCtx.addDir,
              kind: 'vault',
            },
          ]
        : [];
    s.brief = withVaultContext(msg.brief, vaultCtx);
    // A "run this branch" request: the runner finds BUILD.md and the commits itself (the server never reads repositories).
    if (msg.kind === 'devops' && msg.devops?.run && this.deps.runs) {
      const run = msg.devops.run;
      run.buildDocs = await this.deps.runs.buildDocs(run.envId).catch(() => []);
      const commits = this.deps.runs.sourcesOf(run.envId);
      run.sources = run.sources.map((r) => ({
        ...r,
        commit: commits.find((c) => c.repoId === r.repoId)?.commit ?? r.commit ?? null,
      }));
    }
    const texts = shiftTexts(msg, s.brief);
    // The project's reference repositories (read-only), for a card shift only; only clones this runner found itself.
    const registeredFolders =
      msg.kind === 'card'
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
    const readFolders = mergeReadFolders(registeredFolders, folderRepos);
    if (msg.kind === 'card')
      texts.instructions += `\n${renderReadableFolders(readFolders, { workingDir: cwd })}\n`;
    else if (vaultReadFolder.length > 0)
      texts.instructions += `\n${renderReadableFolders(vaultReadFolder, { workingDir: cwd })}\n`;
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
    if (s.syncMain && msg.kind === 'card') texts.prompt += `\n${mainSyncNote(s.syncMain)}\n`;
    const tc = this.deps.toolchains?.resolve();
    if (tc && msg.kind !== 'devops')
      texts.instructions += `\n${toolchainNote(describeToolchains(tc.entries))}\n`;
    const signIn = msg.kind === 'card' ? this.deps.mcpSignInNote?.(msg.mcpServers) : undefined;
    if (signIn) texts.instructions += `\n${signIn}\n`;
    await adapter.writeInstructions(sandbox, texts.instructions);
    s.token = this.deps.ipc.registerShift(this.handlerFor(s));
    s.env = {
      ...sandboxEnv(sandbox, undefined, tc?.env, identity),
      AOM_IPC_URL: this.deps.ipc.url,
      ...(this.deps.ipc.socketPath ? { AOM_IPC_SOCKET: this.deps.ipc.socketPath } : {}),
      AOM_SHIFT_TOKEN: s.token,
      AOM_SHIFT_ID: msg.shiftId,
      // A suite or regression card of a phase follow-up tests the deployed app: Playwright configs read this.
      ...(msg.agent.roleKey === 'tester' && typeof msg.brief.card.fields.targetUrl === 'string'
        ? { AOM_TARGET_URL: msg.brief.card.fields.targetUrl }
        : {}),
      PATH: tc ? agentPath(tc, paths.bin) : `${paths.bin}${delimiter}${process.env.PATH ?? ''}`,
    };

    try {
      s.session = await adapter.start({
        shiftId: msg.shiftId,
        prompt: texts.prompt,
        instructionsMarkdown: texts.instructions,
        cwd,
        sandbox,
        agent: msg.agent as AgentRuntimeSpec,
        env: s.env,
        addDirs: vaultCtx && msg.kind === 'card' ? [vaultCtx.addDir] : [],
        readDirs: [...readFolders, ...vaultReadFolder].map((f) => f.path),
        ...(tc ? { toolchainReadDirs: tc.readDirs } : {}),
        // plugin MCP servers: card shifts only (the DevOps engineer, questions and BA tasks keep their behaviour)
        ...(msg.kind === 'card' && msg.mcpServers?.length ? { mcpServers: msg.mcpServers } : {}),
        maxShiftMinutes: msg.maxShiftMinutes,
        logFile: `${paths.shiftLogs}/${msg.shiftId}.jsonl`,
      });
    } catch (err) {
      this.startFailed(s, err);
      return;
    }

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
              },
            }
          : {}),
        ...(s.worktree?.createdBranch ? { branchCreated: s.worktree.createdBranch } : {}),
        ...(s.originBranches ? { originBranches: s.originBranches } : {}),
        ...(s.syncMain ? { syncMain: s.syncMain } : {}),
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
    this.addProgress(s, 'status', `shift started on ${msg.agent.runtime}`);

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

    if (msg.worktree && s.worktree && msg.agent.permissions.mayCommit) {
      // A guard rejection leaves the agent's out-of-scope edits in the worktree: discard them, never commit them.
      await discardTestArtifacts(s.worktree.path);
      // (not while a main-branch merge waits for the architect: discarding paths would wreck the merge state)
      if (s.startSha && !(await mergeInProgress(s.worktree.path))) {
        const dropped = await discardOutOfScope(this.guardInput(s, s.worktree.path, s.startSha));
        if (dropped.length > 0)
          this.log.warn(`discarded out-of-scope changes of shift ${msg.shiftId}: ${dropped.join(', ')}`);
      }
      // A shift that ends without a report but with work in the worktree says so on the card (a denied tool used to
      // end shifts silently, with the work only in the worktree).
      const unreported =
        s.reportState === 'none' && (!s.stopReason || s.stopReason === 'timeout' || s.stopReason === 'idle');
      const leftovers = unreported ? await uncommittedFiles(s.worktree.path) : [];
      const committed = await autoCommit({
        worktree: s.worktree.path,
        ticket: ticketOf(msg),
        env: s.env,
      });
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
            ...(sha ? { sha } : {}),
            branch: s.worktree.branchName,
          }),
        });
      }
    }

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

    // The Claude login does not work: not an agent crash. Whatever the agent left is committed above; the card goes back
    // to the queue without penalty and waits (the runtime is reported expired) until the login works again.
    if (exit.authFailed && s.reportState === 'none' && !s.stopReason) {
      this.log.warn(
        `shift ${msg.shiftId}: the ${msg.agent.runtime} login does not work; the shift is put back`,
      );
      await this.deps.beforeAuthReject?.().catch(() => undefined);
      this.reject(msg.shiftId, 'auth_expired', 'The Claude login on this workstation has expired.');
      return;
    }

    let outcome: 'reported' | 'no_report' | 'stopped' | 'crashed' | 'timeout';
    if (s.reportState !== 'none' && s.stopReason !== 'claim_lost') outcome = 'reported';
    else if (s.stopReason === 'timeout' || s.stopReason === 'idle') outcome = 'timeout';
    else if (s.stopReason) outcome = 'stopped';
    else if (exit.code !== 0) outcome = 'crashed';
    else outcome = 'no_report';

    this.deps.transport.send('shift.ended', {
      shiftId: msg.shiftId,
      outcome,
      exitCode: exit.code,
      durationMs: Date.now() - s.startedAt.getTime(),
      usage: s.session.usage(),
      ...(s.finalText || exit.error ? { finalText: (s.finalText ?? exit.error ?? '').slice(0, 4000) } : {}),
      guardViolations: s.guardViolations,
    });
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
      this.addProgress(s, 'tool', `${ev.name}: ${ev.summary}`);
    } else if (ev.kind === 'final') s.finalText = ev.text;
  }

  private addProgress(s: ActiveShift, kind: 'text' | 'tool' | 'status', text: string): void {
    s.progress.push({ at: new Date().toISOString(), kind, text: text.slice(0, 500) });
  }

  private flushProgress(s: ActiveShift): void {
    if (s.progress.length === 0) return;
    const items = s.progress.splice(0, s.progress.length);
    this.deps.transport.send('shift.progress', { shiftId: s.msg.shiftId, items });
  }

  private handlerFor(s: ActiveShift): ShiftIpcHandler {
    return {
      report: async (req: IpcReportRequest) => this.submit(s, req.report),
      rpc: async (req: IpcRpcRequest) => {
        // `aom ceo ...` belongs to the CEO's own shifts (the server checks the agent again).
        if (req.method === 'ceo')
          return s.msg.kind === 'ceo' && s.msg.agent.roleKey === 'ceo'
            ? this.deps.rpc(s.msg.shiftId, req.method, req.params)
            : ({ ok: false, error: 'not_ceo: only the CEO may use `aom ceo`' } as IpcRpcResponse);
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
        if (req.method === 'card.attachments') return this.cardAttachments(s, req.params);
        if (req.method === 'transcript.fetch') return this.transcriptFetch(s, req.params);
        if (req.method === 'sudo.run') return this.sudoRun(s, req.params);
        if (req.method.startsWith('run.')) return this.runRpc(s, req.method, req.params);
        if (req.method.startsWith('toolchain.'))
          return toolchainRpc(
            this.deps.toolchains,
            req.method,
            req.params,
            s.msg.kind === 'devops' && s.msg.agent.isDevops === true,
          );
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
        return { ok: true, result: formatSource(await external.readText(ref)) };
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

  /** The guard's view of this shift: the role's scope plus what the project and the main-branch merges add. */
  private guardInput(s: ActiveShift, worktree: string, startSha: string): GuardInput {
    const { msg } = s;
    const inv = msg.brief.investigation;
    // The architect also writes the project's investigation folder and the card's report path (repository location).
    const extra =
      msg.agent.roleKey === 'architect' && inv && inv.location === 'repo'
        ? [...(inv.folder ? [`${inv.folder}/**`] : []), inv.reportPath]
        : [];
    return {
      worktree,
      roleKey: msg.agent.roleKey,
      permissions: msg.agent.permissions,
      branchName: s.worktree?.branchName ?? '',
      startSha,
      branchesAtStart: s.branchesAtStart,
      e2eGlobs: msg.brief.project.e2eGlobs,
      ...(extra.length ? { extraWritableGlobs: extra } : {}),
      ...(s.mainShas.length ? { mainMergeShas: s.mainShas } : {}),
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
    const wt = s.worktree.path;
    const main = msg.prepare.syncMain?.mainBranch ?? msg.worktree?.mainBranch;
    const r = await mergeMainIntoCard(wt, {
      ...(main ? { mainBranch: main } : {}),
      ref: msg.brief.card.ref,
      commitAs: msg.commitAs ?? null,
      ...(this.deps.gitAuth ? { auth: this.deps.gitAuth } : {}),
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
      ...(this.deps.gitAuth ? { auth: this.deps.gitAuth } : {}),
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
    if (!wt) return { error: 'this shift has no card worktree' };
    const inv = msg.brief.investigation;
    const location = inv?.location ?? 'repo';
    const asked = data.reportPath.trim();
    const secretsIn = (text: string): string | null => {
      const found = scanReportForSecrets(text);
      return found.length
        ? `the report seems to contain ${found.join(', ')}: remove it (never put secrets or credentials in a report)`
        : null;
    };
    if (location === 'repo') {
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
      const leak = secretsIn(readFileSync(real, 'utf8'));
      if (leak) return { error: leak };
      if ((await git(wt, ['cat-file', '-e', `HEAD:${rel}`])).exitCode !== 0)
        return {
          error: `the report '${rel}' is not committed on the card branch: \`git add\` and commit it, then report again`,
        };
      if ((await git(wt, ['status', '--porcelain', '--', rel])).stdout.trim())
        return { error: `the report '${rel}' has uncommitted changes: commit them, then report again` };
      const commit = (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim();
      return { data: { reportPath: rel, summary: data.summary, location: 'repo', commit } };
    }
    // Vault location: the architect wrote the file under its scratch or temp directory; the runner copies it.
    if (!msg.vault || !this.deps.writeVault)
      return {
        error:
          'there is no knowledge vault for this project, so a vault report cannot be saved: ask the manager to use the repository location',
      };
    const sb = s.sandbox;
    const candidates = isAbsolute(asked)
      ? [asked]
      : [sb ? join(sb.tmp, asked) : '', sb ? join(sb.scratch, asked) : '', join(wt, asked)].filter(Boolean);
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
    return { data: { reportPath: vaultPath, summary: data.summary, location: 'vault' } };
  }

  /**
   * `aom sudo -- <command> [args...]` from a DevOps shift: runs the command with administrator rights when the manager
   * granted sudo to this workstation's DevOps engineer. The password never reaches the agent: the runner feeds it to
   * `sudo -S` itself and the output is redacted.
   */
  private async sudoRun(s: ActiveShift, params: Record<string, unknown>): Promise<IpcRpcResponse> {
    const argv = Array.isArray(params.argv) ? params.argv.map(String) : [];
    if (s.msg.kind !== 'devops' || !s.msg.agent.isDevops)
      return { ok: false, error: 'only the DevOps engineer may use sudo' } as IpcRpcResponse;
    if (!s.msg.devops?.access.sudo)
      return {
        ok: false,
        error: 'sudo is not granted to this DevOps engineer: ask the manager with `aom devops-approval`',
      } as IpcRpcResponse;
    if (argv.length === 0 || !this.deps.sudoRun)
      return { ok: false, error: 'usage: aom sudo -- <command> [args...]' } as IpcRpcResponse;
    const [cmd, ...args] = argv as [string, ...string[]];
    this.addProgress(s, 'tool', `sudo ${cmd} ${args.join(' ')}`.slice(0, 200));
    const r = await this.deps.sudoRun(cmd, args);
    return {
      ok: true,
      result: { exitCode: r.exitCode, stdout: r.stdout.slice(-20000), stderr: r.stderr.slice(-8000) },
    } as IpcRpcResponse;
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

    let attach: Record<string, unknown> = {};
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

      if (s.worktree && s.startSha) {
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
            await autoCommit({
              worktree: s.worktree.path,
              ticket: ticketOf(msg),
              env: s.env,
            });
          }
          const prepared = await this.prepareInvestigation(s, toSend.data as unknown as InvestigationData);
          if ('error' in prepared) return rejected(prepared.error);
          toSend = { ...toSend, data: prepared.data as unknown as Record<string, unknown> };
        }
        if (outcome.kind === 'success' && outcome.data === 'diffStats') {
          if (msg.agent.permissions.mayCommit) {
            await autoCommit({
              worktree: s.worktree.path,
              ticket: ticketOf(msg),
              env: s.env,
            });
          }
          const stats = await computeDiffStats({
            worktree: s.worktree.path,
            baseBranch: s.worktree.baseBranch,
            architecturalGlobs: msg.brief.project.architecturalGlobs,
            affectedAreas:
              typeof msg.brief.card.fields.affectedAreas === 'string'
                ? msg.brief.card.fields.affectedAreas
                : '',
          });
          attach = { diffStats: stats, riskTier: riskTier(stats, msg.brief.card.cardType) };
        }
      }
    }

    const reportId = uuidv7();
    if (terminal) s.reportState = 'pending';
    const verdict = new Promise<ReportVerdict | 'timeout'>((resolve) => {
      s.pendingReports.set(reportId, resolve);
      setTimeout(() => {
        if (s.pendingReports.delete(reportId)) resolve('timeout');
      }, this.deps.reportWaitMs ?? 120_000).unref?.();
    });
    this.deps.transport.send('shift.report', { shiftId: msg.shiftId, reportId, report: toSend, ...attach });
    const result = await verdict;

    if (result === 'timeout') {
      // Persisted in the outbox: it will be delivered when the server is reachable.
      return { accepted: true, message: `Queued. ${ACCEPTED_MESSAGE}` };
    }
    if (!result.accepted) {
      if (terminal) s.reportState = 'none';
      return rejected(result.error ?? 'the server rejected the report', result.matches);
    }
    if (terminal) {
      s.reportState = 'accepted';
      s.graceTimer = setTimeout(
        () => void s.session?.stop('report_accepted'),
        this.deps.exitGraceMs ?? 120_000,
      );
      s.graceTimer.unref?.();
    }
    return {
      accepted: true,
      message: result.message ?? (terminal ? ACCEPTED_MESSAGE : 'Recorded.'),
      ...(result.matches ? { matches: result.matches } : {}),
    };
  }
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
