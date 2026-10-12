import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  type AgentRuntimeSpec,
  type GuardViolation,
  hasTranscript,
  type IpcReportRequest,
  type IpcReportResponse,
  type IpcRpcRequest,
  type IpcRpcResponse,
  isPublishRequest,
  isTerminalReport,
  type LedgerMatch,
  normalizeUrl,
  outcomeDataSchema,
  type PublishRequest,
  type RepoReport,
  renderReadableFolders,
  type ServerToRunnerOf,
  type ShiftBrief,
  type ShiftReport,
  ShiftReportSchema,
  type TranscriptRef,
  type Usage,
  uuidv7,
  type VaultWriteCommand,
} from '@aom/shared';
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../adapters/types.ts';
import type { RunnerConfig } from '../config.ts';
import type { Outbox } from '../connection/outbox.ts';
import { cardPayload, shiftTexts } from '../devops/requests.ts';
import { checkFeedItemsFetched, FetchedUrls } from '../feeds/validation.ts';
import { computeDiffStats, riskTier } from '../git/diffstat.ts';
import { git } from '../git/git.ts';
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
import { resolveReadRepos } from '../read-repos.ts';
import { preparePublication } from '../research/publish.ts';
import { ensureSandbox, sandboxEnv } from '../sandbox/sandbox.ts';
import { defaultEnvChecker, type EnvChecker, needsTestEnvironment } from '../testing/environment.ts';
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
import { autoCommit } from './autocommit.ts';
import {
  type BranchSnapshot,
  discardOutOfScope,
  discardTestArtifacts,
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
  /** Forwards an rpc to the server (`rpc.request`). */
  rpc: (shiftId: string, method: string, params: Record<string, unknown>) => Promise<IpcRpcResponse>;
  /** Writes (and commits, pushes) a file into a vault clone: `aom publish` puts research notes there (M6). */
  writeVault?: (
    cmd: VaultWriteCommand,
  ) => Promise<{ written: boolean; committed: boolean; pushed: boolean; paused: boolean }>;
  maxConcurrentShifts?: () => number;
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
  /** Credentials for pushing a working branch the runner creates (absent: the user's own git setup). */
  gitAuth?: GitAuth;
}

/** The server's answer to a `shift.report`: what the agent is told (and any ledger matches for a question). */
interface ReportVerdict {
  accepted: boolean;
  error?: string;
  message?: string;
  matches?: LedgerMatch[];
}

interface ActiveShift {
  msg: ShiftStartMsg;
  startedAt: Date;
  token?: string;
  session?: RuntimeSession;
  worktree?: WorktreeResult;
  startSha?: string;
  branchesAtStart: BranchSnapshot;
  stopReason?: StopReason | 'timeout';
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
}

/** On-disk record of a running shift (`<dataDir>/active-shifts/<shiftId>.json`). */
interface PersistedShift {
  msg: ShiftStartMsg;
  startedSent: boolean;
}

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
  async handleStart(msg: ShiftStartMsg, resume?: { startedSent: boolean }): Promise<void> {
    if (this.active.has(msg.shiftId)) return; // redelivery
    const max = this.deps.maxConcurrentShifts?.() ?? this.deps.config.maxConcurrentShifts;
    if (this.active.size >= max) {
      this.reject(msg.shiftId, 'busy', `${this.active.size} shifts already running`);
      return;
    }
    const shift: ActiveShift = {
      msg,
      startedAt: new Date(),
      branchesAtStart: {},
      reportState: 'none',
      pendingReports: new Map(),
      guardViolations: [],
      progress: [],
      fetched: new FetchedUrls(),
      transcripts: new Map(),
      env: {},
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
        void this.handleStart(rec.msg, { startedSent: rec.startedSent });
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
      const rec: PersistedShift = { msg: s.msg, startedSent: !!s.startedSent };
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

    const sandbox = await ensureSandbox(paths, msg.agent.agentId, msg.agent.name);
    let cwd = sandbox.scratch;

    if (msg.worktree) {
      const repo = await this.deps.findRepo(msg.worktree.remoteUrlNormalized);
      if (!repo) {
        this.reject(msg.shiftId, 'repo_missing', `no local clone for ${msg.worktree.remoteUrlNormalized}`);
        return;
      }
      try {
        s.worktree = await ensureWorktree({
          repoPath: repo.localPath,
          spec: msg.worktree,
          defaultPath: paths.worktreePath(msg.brief.project.key, msg.brief.card.ref, msg.brief.project.id),
          roots: [paths.worktrees],
          auth: this.deps.gitAuth,
        });
        if (msg.prepare.rebase && !s.resumed) await rebaseOntoBase(s.worktree.path, msg.worktree.baseBranch);
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

    // A card shift reads only the vault the server named for this card; a DevOps shift reads none.
    const vaultCtx =
      msg.kind === 'card' && msg.vault ? await readVaultContext(paths.vaults, msg.vault) : null;
    s.brief = withVaultContext(msg.brief, vaultCtx);
    const texts = shiftTexts(msg, s.brief);
    // The project's reference repositories (read-only), for a card shift only; only clones this runner found itself.
    const readFolders =
      msg.kind === 'card'
        ? await resolveReadRepos(msg.readRepos, { findRepo: this.deps.findRepo, runnerRoot: paths.root })
        : [];
    if (msg.kind === 'card')
      texts.instructions += `\n${renderReadableFolders(readFolders, { workingDir: cwd })}\n`;
    await adapter.writeInstructions(sandbox, texts.instructions);
    s.token = this.deps.ipc.registerShift(this.handlerFor(s));
    s.env = {
      ...sandboxEnv(sandbox),
      AOM_IPC_URL: this.deps.ipc.url,
      ...(this.deps.ipc.socketPath ? { AOM_IPC_SOCKET: this.deps.ipc.socketPath } : {}),
      AOM_SHIFT_TOKEN: s.token,
      AOM_SHIFT_ID: msg.shiftId,
      // A suite or regression card of a phase follow-up tests the deployed app: Playwright configs read this.
      ...(msg.agent.roleKey === 'tester' && typeof msg.brief.card.fields.targetUrl === 'string'
        ? { AOM_TARGET_URL: msg.brief.card.fields.targetUrl }
        : {}),
      PATH: `${paths.bin}${delimiter}${process.env.PATH ?? ''}`,
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
        addDirs: vaultCtx ? [vaultCtx.addDir] : [],
        readDirs: readFolders.map((f) => f.path),
        maxShiftMinutes: msg.maxShiftMinutes,
        logFile: `${paths.shiftLogs}/${msg.shiftId}.jsonl`,
      });
    } catch (err) {
      this.deps.transport.send('shift.ended', {
        shiftId: msg.shiftId,
        outcome: 'crashed',
        exitCode: null,
        durationMs: Date.now() - s.startedAt.getTime(),
        usage: zeroUsage(),
        finalText:
          `failed to start ${msg.agent.runtime}: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            4000,
          ),
        guardViolations: [],
      });
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
      });
    if (s.worktree?.createdBranch && !s.startedSent) {
      const b = s.worktree.createdBranch;
      this.addProgress(
        s,
        'status',
        `created working branch ${b.base} from ${b.from}${b.pushed ? ' and pushed it' : ''}`,
      );
    }
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
    if (s.stopReason) void s.session.stop(`stop:${s.stopReason}`); // stop arrived while preparing

    let exit: Extract<RuntimeEvent, { kind: 'exit' }> = { kind: 'exit', code: null };
    try {
      for await (const ev of s.session.events()) {
        if (ev.kind === 'exit') exit = ev;
        else this.onRuntimeEvent(s, ev);
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(flush);
    }
    this.flushProgress(s);

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
      if (s.startSha) {
        const dropped = await discardOutOfScope({
          worktree: s.worktree.path,
          roleKey: msg.agent.roleKey,
          permissions: msg.agent.permissions,
          branchName: s.worktree.branchName,
          startSha: s.startSha,
          branchesAtStart: s.branchesAtStart,
          e2eGlobs: msg.brief.project.e2eGlobs,
        });
        if (dropped.length > 0)
          this.log.warn(`discarded out-of-scope changes of shift ${msg.shiftId}: ${dropped.join(', ')}`);
      }
      await autoCommit({
        worktree: s.worktree.path,
        ref: msg.brief.card.ref,
        stage: msg.brief.shift.stage,
        shiftId: msg.shiftId,
        env: s.env,
      });
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

    let outcome: 'reported' | 'no_report' | 'stopped' | 'crashed' | 'timeout';
    if (s.reportState !== 'none' && s.stopReason !== 'claim_lost') outcome = 'reported';
    else if (s.stopReason === 'timeout') outcome = 'timeout';
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
        // A BA task reads a member card of the phase by ref (`aom card <REF>`): the server answers that.
        // A DevOps shift reads its request's card (`aom card show`) through the server, which serves only that card.
        if (req.method === 'card.get' && s.msg.kind === 'devops' && (req.params.ref || req.params.linked))
          return this.deps.rpc(s.msg.shiftId, req.method, req.params);
        if (req.method === 'card.get' && s.msg.kind === 'ba_task' && req.params.ref)
          return this.deps.rpc(s.msg.shiftId, req.method, req.params);
        if (req.method === 'card.get')
          return { ok: true, result: cardPayload({ ...s.msg, brief: s.brief ?? s.msg.brief }) };
        if (req.method === 'transcript.fetch') return this.transcriptFetch(s, req.params);
        if (req.method === 'sudo.run') return this.sudoRun(s, req.params);
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
            commitMessage: `aom: transcript ${msg.brief.card.ref} ${result.title ?? url}`.slice(0, 120),
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
        commitMessage: `aom: research ${msg.brief.card.ref} ${prepared.publication.title}`.slice(0, 120),
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
        const violations = await runGuard({
          worktree: s.worktree.path,
          roleKey: msg.agent.roleKey,
          permissions: msg.agent.permissions,
          branchName: s.worktree.branchName,
          startSha: s.startSha,
          branchesAtStart: s.branchesAtStart,
          e2eGlobs: msg.brief.project.e2eGlobs,
        });
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
        if (outcome.kind === 'success' && outcome.data === 'diffStats') {
          if (msg.agent.permissions.mayCommit) {
            await autoCommit({
              worktree: s.worktree.path,
              ref: msg.brief.card.ref,
              stage: msg.brief.shift.stage,
              shiftId: msg.shiftId,
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

const rejected = (error: string, matches?: LedgerMatch[]): IpcReportResponse => ({
  accepted: false,
  message: `Report rejected: ${error}`,
  error,
  ...(matches ? { matches } : {}),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

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
