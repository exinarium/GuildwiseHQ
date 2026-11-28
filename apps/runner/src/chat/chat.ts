import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type ChatContext,
  type ChatSegment,
  capChatSegments,
  chatSegmentsText,
  chatToolsFor,
  DEFAULT_DEVOPS_ACCESS,
  DELEGATE_RPC,
  type DevOpsAccess,
  type IpcReportRequest,
  type IpcReportResponse,
  type IpcRpcRequest,
  type IpcRpcResponse,
  isBoardRpc,
  isDelegateServerRpc,
  isSessionRpc,
  JIRA_SKILL_PATH,
  type ReadableFolder,
  type RunnerDiagnosticsResult,
  renderChatInstructions,
  renderDirectSystemPrompt,
  renderSessionTurnInstructions,
  type ServerToRunnerOf,
  sessionToolsFor,
  splitBackendModel,
  summarizeCommandTexts,
  type ToolCounts,
  type Usage,
} from '@aom/shared';
import { formatLimitTime } from '../adapters/claude-usage-limit.ts';
import { holdWorktree, usedSince } from '../adapters/sandbox-placeholders.ts';
import type { RuntimeAdapter, RuntimeSession } from '../adapters/types.ts';
import {
  allowedJiraKeys,
  attachFileFromAgent,
  cardAttachmentsDir,
  describeSynced,
  downloadJiraAttachments,
  listJiraAttachments,
  type ServerHttp,
  syncCardAttachments,
} from '../attachments/index.ts';
import type { PackViewer } from '../capabilities/packs.ts';
import { type CapabilityRegistry, makePackScriptGate, skillRpc } from '../capabilities/registry.ts';
import { type GuardClone, markJobStarted } from '../ceo/guard-hook.ts';
import { selectChatProfile } from '../ceo/profile.ts';
import { composeOwnerMessage, removeTurnDir, turnDirOf, writeTurnFiles } from '../ceo/turn-files.ts';
import {
  type DelegateCaller,
  DelegateRunner,
  type DelegateWork,
  delegateNote,
  delegateUsageReporter,
  stopDelegate,
} from '../delegate/delegate.ts';
import { recordDevopsAudit } from '../devops/audit.ts';
import {
  type CardWorktreeSnapshot,
  enforceCardFence,
  fenceViolation,
  snapshotCardWorktrees,
} from '../devops/card-fence.ts';
import { redactCommand } from '../devops/guard.ts';
import { withInstallScriptsOff } from '../devops/install-env.ts';
import { type ExternalAdapters, formatSource, readScopedJira } from '../external/index.ts';
import { confine } from '../fs-safe.ts';
import { resolveCommitIdentity } from '../git/identity.ts';
import { writerStart } from '../git/pushable-tips.ts';
import { CHAT_GRAPH_NOTE } from '../graph/brief.ts';
import type { GraphService } from '../graph/service.ts';
import type { IpcServer, ShiftIpcHandler } from '../ipc/server.ts';
import { type Logger, nullLogger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import { playbookNote } from '../playbooks/note.ts';
import { mergeReadFolders, resolveOrgFolderRepos, resolveReadRepos } from '../read-repos.ts';
import type { RestartAfterReply } from '../restart-after-reply.ts';
import { cleanAgentTmp, ensureSandbox, holdAgentTmp, type Sandbox, sandboxEnv } from '../sandbox/sandbox.ts';
import { type IssuedShiftCredential, issueShiftCredential } from '../session/shift-credential.ts';
import { noteOutside } from '../toolchain/ensure-lock.ts';
import { agentPath, type ToolchainRegistry, toolchainRpc } from '../toolchain/registry.ts';
import { readVaultContext } from '../vaults/context.ts';

type ChatStartMsg = ServerToRunnerOf<'chat.start'>;

export interface ChatDeps {
  /** `aom skill show|list`, the capability index in an agent's instructions and the persona text of a session turn. */
  capabilities?: CapabilityRegistry;
  /** The project graph (`aom graph query|explain` in a chat). Absent: none. */
  graph?: () => GraphService | undefined;
  paths: RunnerPaths;
  adapters: Map<string, RuntimeAdapter>;
  ipc: IpcServer;
  log?: Logger;
  /** Acked types (`chat.done`, `chat.error`) go through the outbox; `chat.delta` is dropped while offline. */
  send(
    type: 'chat.delta' | 'chat.activity' | 'run.usage' | 'chat.done' | 'chat.error' | 'devops.audit',
    payload: Record<string, unknown>,
  ): string | undefined;
  /** The server accepts `chat.activity` (it announced `CHAT_ACTIVITY_FEATURE` in `welcome`); absent: yes. */
  chatActivity?: () => boolean;
  /** The server accepts `run.usage` (it announced `RUN_USAGE_FEATURE`); absent: no. */
  liveUsage?: () => boolean;
  /** The server accepts the live usage of a delegate (it announced `DELEGATE_GRANTS_FEATURE`). */
  delegateUsage?: () => boolean;
  /** T10: narrows the server's DevOps access by policy.json (Docker); absent: Docker counts as off. */
  narrowAccess?: (a: DevOpsAccess) => DevOpsAccess;
  /** The local opt-in `aom-runner ceo full-power on`, read fresh at each turn (default: off). */
  ceoFullPower?: () => boolean;
  /** R18-S: consumes the one CEO owner turn a local action opened (`guildwise-runner ceo turn`); absent: none. */
  takeOwnerTurn?: () => boolean;
  /** `ceo.ownerPermissions`, read fresh at each turn (default: `auto`). */
  ceoOwnerPermissions?: () => 'bypass' | 'auto';
  /** `aom runner status|logs` in a full-power owner turn: this workstation's status and logs, secrets masked. */
  diagnostics?: (request: unknown) => Promise<RunnerDiagnosticsResult>;
  /** The repository clones on this workstation (the use-the-system hook nudges edits inside them). */
  guardClones?: () => GuardClone[];
  /** `aom runner restart` in an owner turn: the restart that waits for the reply to be acknowledged. */
  restart?: RestartAfterReply;
  /** M7: the ticket systems of this workstation (`aom source read`); credentials never leave it. */
  external?: ExternalAdapters;
  /** Text for the agent's instructions about granted MCP servers that need a sign-in here (empty: none). */
  mcpSignInNote?: (granted: readonly string[] | undefined) => string;
  /** RPC to the server under the chat's id (the server treats a chat as a shift of kind `chat`). */
  rpc(chatId: string, method: string, params: Record<string, unknown>): Promise<IpcRpcResponse>;
  /** This workstation's clone of a repository by normalized remote (its repository scan): the project's read-only repositories. */
  findRepo?(remoteUrlNormalized: string): Promise<{ localPath: string } | undefined>;
  /** This workstation's clone by catalog key (path relative to a repoRoot): reference repositories picked on this workstation. */
  findLocal?(localKey: string): Promise<{ localPath: string } | undefined>;
  /** The organization source folder of an organization (architect chats read every repository under it). */
  orgSourceFolder?(orgId: string): string | undefined;
  repoRoots?(): string[];
  /** The runner's HTTP calls to the server (attachment bytes). */
  http?: ServerHttp;
  /** `aom git status|connect` in the DevOps engineer's chat. */
  git?: { handle(method: string, params: Record<string, unknown>): Promise<IpcRpcResponse> };
  /** Agent toolchains (`aom toolchain` in the DevOps engineer's chat; PATH and read access of every chat). */
  toolchains?: ToolchainRegistry;
}

interface ActiveChat {
  msg: ChatStartMsg;
  /** quiet-approvals R1: a DevOps chat turn inside the box (builder-like sandbox, no guard, no DevOps verbs). */
  devopsBox?: boolean;
  /** An @mention that works in a card worktree holds it for the turn (the DevOps fence never judges it, REVIEW B1). */
  releaseWorktree?: () => void;
  /** gate-fixes-2 D2: ends a work mention's writer count on the card's clone. */
  releaseWriter?: () => Promise<void>;
  session?: RuntimeSession;
  token?: string;
  /** The token's env file; `revoke()` ends both (see session/shift-credential.ts). */
  credential?: IssuedShiftCredential;
  sandbox?: Sandbox;
  releaseTmp?: () => void;
  stopReason?: 'cancelled' | string;
  /** A CEO owner or order turn in the full-power profile: it survives a dropped connection. */
  fullPower?: 'owner' | 'order';
  turnDir?: string;
  /** What a delegate that reads shares with this turn (its working directory and read folders). */
  delegateWork?: DelegateWork;
  /** T9: the card worktrees when this unsandboxed turn (DevOps chat, CEO full power) started. */
  cardFence?: { before: CardWorktreeSnapshot; startedAtMs: number };
  /** The runtime's session id, once it said (a Claude Code transcript folder is named after it). */
  runtimeSessionId?: string;
  /** The dispatch the frames of this turn answer (`chat.start.attemptId`); a re-dispatch of a running turn replaces it. */
  attemptId?: string;
}

/** How many finished chat ids are remembered to ignore a redelivered `chat.start`. */
const RECENT_CHATS = 500;

/**
 * Chat verbs a conversation may use (chat-scoped token): `ledger search`, `comment`, and reading the thread; the BA's
 * intake adds drafting cards and mapping the ticket (the server only allows those in an intake chat).
 */
const CHAT_RPC = new Set([
  'ledger.search',
  'ledger.retire',
  'thread.post',
  'thread.read',
  'card.create',
  'card.update',
  'card.specify',
  'intake.map',
  'intake.unmapped',
  /** Phases: the BA proposes a phase and its cards in an intake chat; the manager confirms on the desk. */
  'phase.list',
  'phase.propose',
  'phase.assign',
  'phase.submit',
  /** M10: the BA's design chat (the server only allows these in the owner's chat with their BA). */
  'org.catalogue',
  'org.role.draft',
  'org.workflow.draft',
  'org.workflowVariant',
  'org.validate',
  'org.submit',
  'org.department',
  /** Approved repository setup: the BA asks, the project owner approves on the desk. */
  'repo.create',
]);
/** The CEO's chat asks for a deploy and reads the status; it never trials or saves a recipe (that is DevOps work). */
const DEPLOY_CHAT_RPC = new Set(['deploy.run', 'deploy.status']);
/** Read-only verbs of the project graph in a chat (docs/design/project-graphs.md section 7). */
const GRAPH_CHAT_RPC = new Set(['graph.query', 'graph.explain']);
/** G-Q1: the DevOps agent's chat can also turn an instruction into a DevOps task (`aom devops "<text>"`). */
const DEVOPS_CHAT_RPC = new Set(['devops.request']);

/** T10: the access a DevOps chat's guard enforces: absent means every switch off; Docker only where policy.json allows. */
export function chatDevopsAccess(
  a: DevOpsAccess | undefined,
  narrow?: (a: DevOpsAccess) => DevOpsAccess,
): { allowInstall: boolean; allowDocker: boolean; allowedPaths: string[] } {
  const base = a ?? DEFAULT_DEVOPS_ACCESS;
  const n = narrow ? narrow(base) : { ...base, allowDocker: false };
  return { allowInstall: n.allowInstall, allowDocker: n.allowDocker, allowedPaths: n.allowedPaths };
}

/** `dir` is the folder `root` or inside it (real paths when they exist). */
function insideDir(root: string, dir: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const r = relative(real(root), real(dir));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/**
 * Runs chat conversations on the agent's workstation (docs/ARCHITECTURE.md section 14): one headless call per user
 * message in the agent's sandbox, streamed back as `chat.delta` and finished with `chat.done` (or `chat.error`).
 * Chats never claim cards and do not count against the shift capacity.
 */
/**
 * Chats run on the account the server named (a chat about a project's card: the project's choice), else on main; the CEO owner
 * turn and session turns always run on main. `available` only says some account is usable, so the account's own gate decides.
 */
const mainOk = (
  adapter: { accountGate?(account: string): { state: string } },
  model?: string,
  account = 'main',
): boolean =>
  // a model behind Bedrock, Vertex or a gateway needs no Claude login
  (model !== undefined && splitBackendModel(model) !== null) ||
  (adapter.accountGate?.(account) ?? { state: 'ok' }).state === 'ok';

/**
 * Who asks the registry for a chat or a session turn, for private packs: a session turn of a creator who is this workstation's own
 * user is the owner's (their private packs are served); any other chat is an agent, which only gets what its owner granted it.
 */
export function viewerOfChat(msg: {
  agent: { agentId: string };
  session?: { ownerSession?: boolean } | undefined;
}): PackViewer {
  return msg.session ? { owner: msg.session.ownerSession === true } : { agentId: msg.agent.agentId };
}

export class ChatManager {
  private readonly active = new Map<string, ActiveChat>();
  /** Chats that ran to an end in this process: a redelivered `chat.start` of one is ignored. */
  private readonly recent = new Set<string>();
  private readonly log: Logger;
  /** `aom delegate`: read-only persona sub-tasks of a running turn (costs booked under it). */
  private readonly delegates: DelegateRunner;

  constructor(readonly deps: ChatDeps) {
    this.log = deps.log ?? nullLogger;
    this.delegates = new DelegateRunner({
      adapters: deps.adapters,
      paths: deps.paths,
      ipc: deps.ipc,
      rpc: (id, method, params) => deps.rpc(id, method, params),
      reportUsage: delegateUsageReporter(
        () => deps.delegateUsage?.() === true,
        (id, usage) => deps.send('run.usage', { kind: 'delegate', id, usage }),
      ),
      ...(deps.capabilities ? { capabilities: deps.capabilities } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
  }

  get size(): number {
    return this.active.size;
  }

  /** The chats running right now (announced in `hello.activeChats`). */
  activeIds(): string[] {
    return [...this.active.keys()];
  }

  /**
   * Folders the running turns work in or read (a card worktree a chat reads, shared with its delegate children). The
   * stale-worktree sweep never removes one of them.
   */
  worktreePaths(): string[] {
    return [...this.active.values()].flatMap((c) =>
      c.delegateWork ? [c.delegateWork.cwd, ...c.delegateWork.readDirs] : [],
    );
  }

  private remember(chatId: string): void {
    this.recent.add(chatId);
    if (this.recent.size > RECENT_CHATS) {
      const first = this.recent.values().next().value;
      if (first !== undefined) this.recent.delete(first);
    }
  }

  /** The outbox frame of each chat's terminal message (`chat.done` or `chat.error`): the restart waits for its ack. */
  private readonly terminalFrames = new Map<string, string>();

  /** The id of the frame that ends chat `chatId`, once it was sent. */
  terminalFrameId(chatId: string): string | undefined {
    return this.terminalFrames.get(chatId);
  }

  private terminal(chatId: string, id: string | undefined): void {
    if (typeof id !== 'string') return;
    this.terminalFrames.set(chatId, id);
    if (this.terminalFrames.size > RECENT_CHATS) {
      const first = this.terminalFrames.keys().next().value;
      if (first !== undefined) this.terminalFrames.delete(first);
    }
  }

  /** The runner's local gate refused this chat (R18-S: a DevOps chat without a local grant): it ends with chat.error. */
  refuseStart(msg: ChatStartMsg, error: string): void {
    this.error(msg, error);
  }

  private error(msg: ChatStartMsg, error: string): void {
    this.terminal(
      msg.chatId,
      this.deps.send('chat.error', { chatId: msg.chatId, threadId: msg.threadId, error }),
    );
  }

  /** The dispatch id the frames of a chat carry (a running chat, or one that ended a moment ago). */
  attemptOf(chatId: string): string | undefined {
    return this.active.get(chatId)?.attemptId ?? this.attempts.get(chatId);
  }

  private readonly attempts = new Map<string, string>();
  private noteAttempt(chatId: string, attemptId: string | undefined): void {
    if (!attemptId) {
      this.attempts.delete(chatId);
      return;
    }
    this.attempts.set(chatId, attemptId);
    if (this.attempts.size > RECENT_CHATS) {
      const first = this.attempts.keys().next().value;
      if (first !== undefined) this.attempts.delete(first);
    }
  }

  async handleStart(msg: ChatStartMsg, opts: { devopsBox?: boolean } = {}): Promise<void> {
    const running = this.active.get(msg.chatId);
    if (running) {
      // The server sent the turn again (it had lost track of it) while this runner still has it: the work goes on, and its
      // frames now answer the newest dispatch.
      if (msg.attemptId && msg.attemptId !== running.attemptId) {
        running.attemptId = msg.attemptId;
        this.noteAttempt(msg.chatId, msg.attemptId);
      }
      return;
    }
    if (this.recent.has(msg.chatId)) {
      // A redelivery of the dispatch that ended here is ignored; a NEW dispatch of a turn that already ended here (its reply was
      // taken for lost) is work to do again, because the reply of the old dispatch is no longer the one the server waits for.
      if (!msg.attemptId || msg.attemptId === this.attempts.get(msg.chatId)) return;
      this.recent.delete(msg.chatId);
    }
    const chat: ActiveChat = {
      msg,
      ...(msg.attemptId ? { attemptId: msg.attemptId } : {}),
      ...(opts.devopsBox && msg.agent.isDevops ? { devopsBox: true } : {}),
    };
    this.noteAttempt(msg.chatId, msg.attemptId);
    this.active.set(msg.chatId, chat);
    // tool-pin-lib S6: a DevOps chat turn outside the box runs as the user and could write the Guildwise tool folder
    const outside = msg.agent.isDevops === true && !chat.devopsBox;
    if (outside) noteOutside(1);
    try {
      await this.run(chat);
    } catch (err) {
      this.log.error(`chat ${msg.chatId} failed unexpectedly`, err);
      this.error(msg, err instanceof Error ? err.message : String(err));
    } finally {
      if (outside) noteOutside(-1);
      if (chat.credential) chat.credential.revoke();
      else if (chat.token) this.deps.ipc.revoke(chat.token);
      this.delegates.endCaller(msg.chatId, 'the turn ended');
      this.active.delete(msg.chatId);
      this.remember(msg.chatId);
      if (chat.turnDir) removeTurnDir(chat.turnDir);
      this.deps.restart?.turnFinished(msg.chatId, this.terminalFrames.get(msg.chatId));
      chat.releaseWorktree?.();
      await chat.releaseWriter?.().catch(() => undefined);
      chat.releaseTmp?.();
      if (chat.sandbox) await cleanAgentTmp(chat.sandbox.tmp);
    }
  }

  /** Not the CEO's and not the DevOps engineer's plain chats; a session turn holds its session's grants. */
  private scriptGate(chatId: string) {
    return makePackScriptGate((id, m, p) => this.deps.rpc(id, m, p), chatId);
  }

  private mayDelegate(msg: ChatStartMsg): boolean {
    return !!msg.session || (!msg.agent.isDevops && msg.agent.roleKey !== 'ceo');
  }

  /** The delegation targets of a chat or turn: a session turn's are the session's, a chat's are its agent's. */
  private delegationOf(msg: ChatStartMsg): ChatStartMsg['delegation'] {
    return msg.session ? msg.session.delegation : msg.delegation;
  }

  /** The chat or turn as the caller of a delegate. It only reads, so no child it starts is wider than reading. */
  private delegateCaller(chat: ActiveChat): DelegateCaller {
    const { msg } = chat;
    return {
      id: msg.chatId,
      runtime: msg.agent.runtime,
      ...(msg.context?.projectId ? { projectId: msg.context.projectId } : {}),
      ...(msg.context?.orgId ? { orgId: msg.context.orgId } : {}),
      viewer: viewerOfChat(msg),
      permissions: {
        ...msg.agent.permissions,
        allowedTools: ['read'],
        writableGlobs: [],
        mayCommit: false,
        browser: false,
      },
      delegation: this.mayDelegate(msg) ? this.delegationOf(msg) : undefined,
      ...(msg.agent.packScriptsGated ? { packScriptsGated: true } : {}),
      ...(chat.delegateWork ? { work: chat.delegateWork } : {}),
    };
  }

  async handleCancel(chatId: string): Promise<void> {
    // the server's cap stop names a running delegate by its own id
    if (stopDelegate(chatId, 'cancelled')) return;
    const c = this.active.get(chatId);
    if (!c) return;
    c.stopReason ??= 'cancelled';
    this.delegates.endCaller(chatId, 'cancelled');
    await c.session?.stop('chat.cancel');
  }

  /**
   * The connection dropped (or the runner stops): the server fails these chats too; the error reaches it through the
   * outbox. A CEO owner or order turn is kept when `keepFullPower` is set (a dropped connection): its `chat.done` goes
   * through the durable outbox and is delivered on reconnect.
   */
  async cancelAll(reason: string, opts: { keepFullPower?: boolean } = {}): Promise<void> {
    await Promise.all(
      [...this.active.values()]
        .filter((c) => !(opts.keepFullPower && c.fullPower))
        .map(async (c) => {
          c.stopReason ??= reason;
          await c.session?.stop(`chat.${reason}`);
        }),
    );
  }

  /** Registers the turn's token, writes its env file and returns the shift variables (revoked in `start`'s `finally`). */
  private issueCredential(
    chat: ActiveChat,
    opts: { extra?: { AOM_CEO_TURN_DIR: string }; socket?: boolean } = {},
  ): Record<string, string> {
    chat.credential?.revoke();
    const cred = issueShiftCredential(
      { ipc: this.deps.ipc, runnerRoot: this.deps.paths.root, log: this.log },
      {
        sessionId: chat.msg.chatId,
        handler: this.handlerFor(chat),
        ...(opts.extra ? { extra: opts.extra } : {}),
        ...(opts.socket === false ? { socket: false } : {}),
      },
    );
    chat.token = cred.token;
    chat.credential = cred;
    return cred.env;
  }

  private handlerFor(chat: ActiveChat): ShiftIpcHandler {
    const { chatId } = chat.msg;
    return {
      report: async (req: IpcReportRequest): Promise<IpcReportResponse> => {
        if (chat.msg.session)
          return {
            accepted: false,
            message: 'Not available in a session turn: answer in your reply.',
            error: 'not available in a session turn',
          };
        // `aom devops-approval` in the DevOps engineer's chat: the owner is in the conversation, so the request is
        // posted there (a chat has no shift to end) and the agent waits for their answer.
        if (
          chat.msg.agent.isDevops &&
          req.report.kind === 'outcome' &&
          req.report.outcomeId === 'devops_approval'
        ) {
          const d = req.report.data as { action?: string; reason?: string; commands?: string[] };
          const body = [
            `**Approval needed:** ${d.action ?? req.report.note}`,
            d.reason ? `Reason: ${d.reason}` : '',
            d.commands?.length
              ? `Commands:\n${d.commands.map((c) => `- \`${redactCommand(c)}\``).join('\n')}`
              : '',
            'Reply here to approve or decline.',
          ]
            .filter(Boolean)
            .join('\n\n');
          const r = await this.deps.rpc(chatId, 'thread.post', { body });
          return r.ok
            ? {
                accepted: true,
                message:
                  'Asked in this conversation. Do not run the command yet: wait for the owner to reply. Commands that leave this workstation stay blocked in a chat; for an approved deployment file a request with `aom devops "<what>"`, which runs as a shift with the approval.',
              }
            : { accepted: false, message: `Rejected: ${r.error ?? 'failed'}`, error: r.error ?? 'failed' };
        }
        if (req.report.kind !== 'comment') {
          return {
            accepted: false,
            message: 'Not available in a chat conversation: only `aom comment` and `aom ledger search`.',
            error: 'not available in chat',
          };
        }
        const r = await this.deps.rpc(chatId, 'thread.post', { body: req.report.note });
        return r.ok
          ? { accepted: true, message: 'Recorded.' }
          : { accepted: false, message: `Rejected: ${r.error ?? 'failed'}`, error: r.error ?? 'failed' };
      },
      rpc: async (req: IpcRpcRequest): Promise<IpcRpcResponse> => {
        // quiet-approvals [B1]: a DevOps chat turn in the box keeps no DevOps verb (it can file a request instead)
        if (
          chat.devopsBox &&
          ((req.method.startsWith('toolchain.') && req.method !== 'toolchain.list') ||
            req.method.startsWith('git.') ||
            req.method === 'devops.outside')
        )
          return {
            ok: false,
            error: `\`${req.method}\` is not available in a DevOps chat inside the safety box: file a DevOps request (\`aom devops "<what is needed>"\`) for work outside it`,
          };
        if (req.method === 'skill.show' || req.method === 'skill.list')
          return skillRpc(
            this.deps.capabilities,
            req.method,
            req.params,
            chat.msg.context?.projectId,
            chat.msg.context?.orgId,
            viewerOfChat(chat.msg),
            chat.msg.agent.packScriptsGated ? this.scriptGate(chatId) : undefined,
          );
        // `aom delegate`: a sub-task for a granted target (a chat only reads, so its children only read). A session turn
        // holds the session's grants; of the plain chats not the CEO's and the DevOps engineer's. The server decides in
        // `delegate.begin`; the runner only knows the targets it was told about at the start.
        if (req.method === DELEGATE_RPC) {
          if (!this.mayDelegate(chat.msg))
            return { ok: false, error: '`aom delegate` is not available to this agent' };
          return this.delegates.run(this.delegateCaller(chat), req.params);
        }
        // the `Agent` tool's guard hook (Claude Code native subagents)
        if (req.method === 'delegate.guard') {
          if (!this.mayDelegate(chat.msg))
            return { ok: false, error: 'subagents are not available to this agent' };
          return this.delegates.guardNative(this.delegateCaller(chat), req.params);
        }
        // The runner's own questions to the server about a delegate are not for the agent to ask.
        if (isDelegateServerRpc(req.method)) return { ok: false, error: `${req.method} is not available` };
        // A turn of a discovery or boardroom session reads and talks: `aom ledger search` and the `aom session ...` verbs
        // are all that reach the server from it (which verbs a turn may use, the server decides from what the turn is for).
        if (chat.msg.session)
          return req.method === 'ledger.search' || isSessionRpc(req.method) || isBoardRpc(req.method)
            ? this.deps.rpc(chatId, req.method, req.params)
            : { ok: false, error: `${req.method} is not available in a session turn` };
        // The owner's chat with the CEO: `aom ceo ...` (the server checks the agent and the owner again).
        if (req.method === 'ceo') {
          if (chat.msg.agent.roleKey !== 'ceo')
            return { ok: false, error: 'not_ceo: only the CEO may use `aom ceo`' };
          if (req.params.op === 'route') {
            // read-only, answered here from the organization graph in the organization vault
            const q = typeof req.params.q === 'string' ? req.params.q.trim() : '';
            const drafts = req.params.drafts === true;
            const text =
              q || drafts ? this.deps.graph?.()?.route(chat.msg.context.orgGraph, q, { drafts }) : null;
            return text
              ? { ok: true, result: { text } }
              : { ok: false, error: 'the organization graph is not available on this workstation' };
          }
          // `aom ceo job start` also opens the use-the-system hook for the rest of this turn (a nudge, not a boundary).
          if (chat.fullPower && chat.turnDir && req.params.op === 'job' && req.params.sub === 'start')
            markJobStarted(chat.turnDir);
          return this.deps.rpc(chatId, req.method, req.params);
        }
        // `aom runner status|logs`: this workstation's status and logs for the Owner's own CEO chat (read-only, masked).
        if (req.method === 'runner.status' || req.method === 'runner.logs')
          return this.runnerDiagnostics(chat, req.method, req.params);
        // `aom runner restart`: only in a full-power owner turn; the restart waits for this turn's reply (design 5.6).
        if (req.method === 'runner.restart') return this.runnerRestart(chat, req.params);
        if (req.method === 'source.read') return this.readSource(chat, req.params);
        if (
          req.method === 'source.attachments' ||
          req.method === 'source.attachment' ||
          req.method === 'card.attachments' ||
          req.method === 'card.attach'
        )
          return this.attachments(chat, req.method, req.params);
        if (req.method.startsWith('toolchain.'))
          return toolchainRpc(this.deps.toolchains, req.method, req.params, chat.msg.agent.isDevops === true);
        // The DevOps engineer's guard hook (devops/guard.ts) reports every command it saw in this conversation.
        if (req.method === 'devops.audit')
          return recordDevopsAudit(req.params, {
            isDevops: chat.msg.agent.isDevops === true,
            logFile: join(this.deps.paths.logs, 'devops-audit.jsonl'),
            send: (entries) => this.deps.send('devops.audit', { entries }),
            redact: redactCommand,
          });
        if (req.method === 'git.status' || req.method === 'git.connect')
          return chat.msg.agent.isDevops && this.deps.git
            ? this.deps.git.handle(req.method, req.params)
            : { ok: false, error: 'only the DevOps engineer can use `aom git`' };
        if (req.method.startsWith('graph.')) {
          if (!GRAPH_CHAT_RPC.has(req.method))
            return { ok: false, error: `${req.method} is not available in a chat conversation` };
          const g = this.deps.graph?.();
          return g
            ? g.rpc(req.method, req.params, chat.msg.context.graph)
            : { ok: false, error: 'the code graph is not available on this workstation' };
        }
        return CHAT_RPC.has(req.method) ||
          (chat.msg.agent.roleKey === 'ceo' && DEPLOY_CHAT_RPC.has(req.method)) ||
          (chat.msg.agent.isDevops && DEVOPS_CHAT_RPC.has(req.method))
          ? this.deps.rpc(chatId, req.method, req.params)
          : { ok: false, error: `${req.method} is not available in a chat conversation` };
      },
    };
  }

  /** `aom runner status|logs [--kind ..] [--name ..] [--lines N] [--grep ..] [--since ..]`: the Owner's CEO chat only. */
  private async runnerDiagnostics(
    chat: ActiveChat,
    method: string,
    params: Record<string, unknown>,
  ): Promise<IpcRpcResponse> {
    if (chat.fullPower !== 'owner' || !this.deps.diagnostics)
      return {
        ok: false,
        error:
          '`aom runner status|logs` is available in the CEO chat with the Owner (full power) only. ' +
          "A standing-order turn, a wake and every other agent cannot read the runner's logs.",
      };
    const result = await this.deps.diagnostics(
      method === 'runner.status' ? { ...params, kind: 'status' } : params,
    );
    return { ok: true, result };
  }

  private async runnerRestart(chat: ActiveChat, params: Record<string, unknown>): Promise<IpcRpcResponse> {
    if (chat.fullPower !== 'owner' || !this.deps.restart)
      return {
        ok: false,
        error: "`aom runner restart` is available in the owner's CEO chat and in DevOps shifts only",
      };
    const reason = typeof params.reason === 'string' ? params.reason.slice(0, 500) : undefined;
    this.deps.restart.request(chat.msg.chatId, reason);
    await this.deps.rpc(chat.msg.chatId, 'ceo', { op: 'restart', ...(reason ? { reason } : {}) });
    return { ok: true, result: { message: 'Restart scheduled after this reply. Finish your reply now.' } };
  }

  /**
   * Attachments in a chat: `source.attachments|attachment` (Jira files, downloaded by the runner with its own credentials
   * for the ticket this conversation is about), `card.attachments` (copies of the attached files of the cards in reach)
   * and `card.attach` (the BA puts a downloaded file on a card of its intake).
   */
  private async attachments(
    chat: ActiveChat,
    method: string,
    params: Record<string, unknown>,
  ): Promise<IpcRpcResponse> {
    const sb = chat.sandbox;
    if (!sb) return { ok: false, error: 'this conversation has no workspace yet' };
    const { chatId } = chat.msg;
    try {
      if (method === 'source.attachments' || method === 'source.attachment') {
        const deps = {
          jira: () => this.deps.external?.jira,
          scratch: sb.scratch,
          allowed: allowedJiraKeys({
            intake: chat.msg.context.intake,
            cardExternalRef: chat.msg.context.cardExternalRef,
          }),
        };
        return {
          ok: true,
          result:
            method === 'source.attachments'
              ? await listJiraAttachments(deps, params.key)
              : await downloadJiraAttachments(
                  deps,
                  params.key,
                  typeof params.name === 'string' ? params.name : undefined,
                  params.all === true,
                ),
        };
      }
      const http = this.deps.http;
      if (!http) return { ok: false, error: 'this runner cannot reach the server for files' };
      if (method === 'card.attach') {
        const ref = typeof params.ref === 'string' && params.ref ? params.ref : undefined;
        return {
          ok: true,
          result: await attachFileFromAgent({
            path: String(params.path ?? ''),
            ref,
            roots: [sb.scratch, sb.tmp],
            rpc: (m, p) => this.deps.rpc(chatId, m, p),
            http,
          }),
        };
      }
      // card.attachments
      const listed = await this.deps.rpc(chatId, 'card.attachments', params.ref ? { ref: params.ref } : {});
      if (!listed.ok) return listed;
      const cards = (
        listed.result as { cards: Array<{ ref: string; attachments: Array<Record<string, unknown>> }> }
      ).cards;
      const synced = await syncCardAttachments({
        dest: cardAttachmentsDir(sb.tmp),
        shiftId: chatId,
        http,
        items: cards.flatMap((c) =>
          c.attachments.map((a) => ({
            ref: c.ref,
            attachment: a as unknown as import('@aom/shared').BriefAttachment,
          })),
        ),
      });
      return { ok: true, result: describeSynced(synced) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The manager's own Jira skill (`skills/jira.md` in the organization vault) replaces the built-in text in an intake chat. */
  private async jiraSkill(msg: ChatStartMsg): Promise<string | undefined> {
    const vaultId = msg.context.intake?.orgVaultId;
    if (!vaultId) return undefined;
    try {
      const file = join(this.deps.paths.vaults, vaultId, ...JIRA_SKILL_PATH.split('/'));
      return existsSync(file) ? await readFile(file, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  }

  /** `aom source read --ref <ticket>`: read a ticket on this workstation (GitHub through `gh`; Jira is the agent's skill). */
  private async readSource(chat: ActiveChat, params: Record<string, unknown>): Promise<IpcRpcResponse> {
    const ref = String(params.ref ?? '').trim();
    if (!ref) return { ok: false, error: 'usage: aom source read --ref <owner/repo#12>' };
    if (!this.deps.external) return { ok: false, error: 'this runner has no ticket adapters' };
    try {
      const scoped = await readScopedJira(this.deps.external, ref, {
        intake: chat.msg.context.intake,
        cardExternalRef: chat.msg.context.cardExternalRef,
      });
      if (scoped !== null) return { ok: true, result: scoped };
      return { ok: true, result: formatSource(await this.deps.external.readText(ref)) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The full text of the Bash commands of a CEO turn (redacted), kept on this machine only. */
  private auditCommands(chatId: string, commands: string[]): void {
    try {
      const dir = join(this.deps.paths.logs, 'ceo-turns');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(
        join(dir, `${chatId.replace(/[^A-Za-z0-9_-]/g, '_')}.commands.log`),
        `${commands.join('\n')}\n`,
        {
          mode: 0o600,
        },
      );
    } catch {
      // the audit is best effort
    }
  }

  /** Tool use of a session, for `chat.done.toolCounts` and the audit of the Bash commands. */
  private countTool(t: { name: string; summary: string }, counts: ToolCounts, commands: string[]): void {
    if (t.name === 'Bash') {
      counts.bash++;
      if (commands.length < 200) commands.push(redactCommand(t.summary).slice(0, 500));
    } else if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(t.name)) counts.edit++;
    else if (t.name.startsWith('mcp__')) {
      if (t.name !== 'mcp__aom_permission__ask') counts.mcp++;
    } else counts.other++;
  }

  /**
   * A CEO owner or order turn in the full-power profile (docs/design/ceo-front-door.md section 3.3): the Owner's own Claude
   * Code, no sandbox. Only reached after `selectChatProfile` said `full` (server-decided mode, CEO agent, local opt-in,
   * authorized order). The reply goes through the durable outbox, and the turn survives a dropped connection.
   */
  private async runOwnerTurn(chat: ActiveChat, mode: 'owner' | 'order'): Promise<void> {
    const { msg } = chat;
    const { paths } = this.deps;
    const adapter = this.deps.adapters.get(msg.agent.runtime);
    const caps = adapter ? await adapter.capabilities() : undefined;
    if (!adapter?.startOwnerTurn || !caps?.available || !mainOk(adapter))
      return this.error(
        msg,
        `runtime ${msg.agent.runtime} is not available for the CEO's full-power turns on this workstation`,
      );
    // T8: a server-chosen folder inside the card worktrees is refused (relative paths there would escape the floor)
    const inCards = [msg.cwd, ...(msg.addDirs ?? [])].find(
      (d): d is string => typeof d === 'string' && insideDir(paths.worktrees, d),
    );
    if (inCards)
      return this.error(
        msg,
        `a full-power turn never works in a card's folder (${inCards}); ask the card's own agents, or read it from elsewhere`,
      );
    chat.fullPower = mode;
    const permissionMode = this.deps.ceoOwnerPermissions?.() ?? 'auto';
    const effective = mode === 'owner' && permissionMode === 'bypass' ? 'bypass' : 'auto';
    this.auditCommands(msg.chatId, [`# ${mode} turn, permission mode: ${effective}`]);
    const turnDir = turnDirOf(paths.root, msg.chatId);
    chat.turnDir = turnDir;
    const shiftEnv = this.issueCredential(chat, { extra: { AOM_CEO_TURN_DIR: turnDir } });
    writeTurnFiles({
      turnDir,
      brief: msg.context.ceo?.brief ?? '',
      mode,
      shiftEnv,
      runnerRoots: [paths.root],
      pid: process.pid,
      clones: this.deps.guardClones?.() ?? [],
    });
    const cwd = msg.cwd && existsSync(msg.cwd) ? msg.cwd : homedir();
    await this.fenceStart(chat);
    chat.session = await adapter.startOwnerTurn({
      chatId: msg.chatId,
      mode,
      message: composeOwnerMessage(msg),
      cwd,
      agent: msg.agent,
      env: {
        ...shiftEnv,
        PATH: `${paths.bin}${delimiter}${process.env.PATH ?? ''}`,
      },
      turnDir,
      ...(msg.resumeSessionId ? { resumeSessionId: msg.resumeSessionId } : {}),
      ...(msg.addDirs?.length ? { addDirs: msg.addDirs } : {}),
      permissionMode,
      logFile: `${paths.shiftLogs}/chat-${msg.chatId}.jsonl`,
    });
    if (chat.stopReason) void chat.session.stop(`chat.${chat.stopReason}`);
    await this.finishTurn(chat, {
      fullPower: true,
      ...(mode === 'owner' ? { permissionMode: effective } : {}),
    });
  }

  /**
   * T9: a DevOps chat turn or a CEO full-power turn runs unsandboxed: the card worktrees are snapshotted at its start
   * (`fenceStart`) and checked when it ends, whichever way (`fenceEnd`, from a `finally`). What it changed is reverted
   * (commits kept under refs/guildwise/refused/, files under a kept commit), logged at WARN and audited; the reply or
   * the error says so in one sentence. A worktree a shift used meanwhile is left alone.
   */
  private async fenceStart(chat: ActiveChat): Promise<void> {
    if (!(chat.msg.agent.isDevops === true || chat.fullPower)) return;
    try {
      chat.cardFence = {
        before: await snapshotCardWorktrees(this.deps.paths.worktrees),
        startedAtMs: Date.now(),
      };
    } catch (err) {
      this.log.warn(`chat ${chat.msg.chatId}: the card worktrees could not be recorded: ${String(err)}`);
    }
  }

  private async fenceEnd(chat: ActiveChat): Promise<string> {
    const fence = chat.cardFence;
    if (!fence) return '';
    chat.cardFence = undefined;
    try {
      const findings = await enforceCardFence({
        root: this.deps.paths.worktrees,
        before: fence.before,
        shiftId: chat.msg.chatId,
        usedByOthers: (p) => usedSince(p, fence.startedAtMs),
      });
      if (findings.length === 0) return '';
      const v = fenceViolation(findings);
      this.log.warn(`chat ${chat.msg.chatId.slice(0, 8)}: ${v.detail}`);
      const who = chat.fullPower ? 'CEO full-power turn' : 'DevOps chat';
      this.deps.send('devops.audit', {
        entries: findings.map((f) => ({
          at: new Date().toISOString(),
          sessionRef: chat.msg.chatId.slice(0, 100),
          kind: 'chat',
          decision: 'refused',
          rule: 'card_worktree',
          command: redactCommand(`# ${who} changed ${f.path}: ${f.changed}`).slice(0, 2000),
        })),
      });
      const all = findings.every((f) => f.reverted);
      return `This ${chat.fullPower ? 'turn' : 'chat'} changed a card's folder, which it never may; the runner ${all ? 'put it back' : 'put back what it could (check it)'}: ${findings.map((f) => f.path).join(', ')}.`;
    } catch (err) {
      this.log.warn(`chat ${chat.msg.chatId}: the card worktree check failed: ${String(err)}`);
      return '';
    }
  }

  /** Reads a session to its end and reports it: `chat.done` (or `chat.error`). */
  private async finishTurn(
    chat: ActiveChat,
    o: { fullPower: boolean; degraded?: string; permissionMode?: 'bypass' | 'auto' },
  ): Promise<void> {
    try {
      await this.readTurn(chat, o, () => this.fenceEnd(chat));
    } finally {
      // every exit, a thrown error and a stop included: the card worktrees are checked once
      if (chat.cardFence) await this.fenceEnd(chat);
    }
  }

  private async readTurn(
    chat: ActiveChat,
    o: { fullPower: boolean; degraded?: string; permissionMode?: 'bypass' | 'auto' },
    fence: () => Promise<string>,
  ): Promise<string> {
    const { msg } = chat;
    const session = chat.session;
    if (!session) return '';
    let sessionId: string | undefined;
    let streamed = '';
    let finalText: string | undefined;
    const counts: ToolCounts = { bash: 0, edit: 0, mcp: 0, other: 0 };
    const commands: string[] = [];
    // The turn as the browser shows it: text blocks, tool calls and thinking, in order (`chat.activity`, `chat.done.segments`).
    const segments: ChatSegment[] = [];
    const toolAt = new Map<string, number>();
    const activityOn = this.deps.chatActivity?.() ?? true;
    const activity = (seq: number, segment: ChatSegment, replace?: boolean): void => {
      if (!activityOn) return;
      this.deps.send('chat.activity', {
        chatId: msg.chatId,
        threadId: msg.threadId,
        seq,
        segment,
        ...(replace ? { replace: true } : {}),
      });
    };
    /** A new, empty text segment (the browser starts a new paragraph); not announced for the first step of a turn. */
    const startText = (): void => {
      const last = segments[segments.length - 1];
      if (last?.type === 'text' && !last.text) return;
      segments.push({ type: 'text', text: '' });
      if (segments.length > 1) activity(segments.length - 1, { type: 'text', text: '' });
    };
    let exit: {
      code: number | null;
      error?: string;
      authFailed?: boolean;
      usageLimit?: { until: string };
    } = { code: null };
    let usageSentAt = 0;
    let fenceNote = '';
    const withFence = (text: string): string => (fenceNote ? `${text}\n\n${fenceNote}` : text);
    try {
      for await (const ev of session.events()) {
        if (ev.kind === 'usage' && this.deps.liveUsage?.() && Date.now() - usageSentAt >= 3000) {
          // live usage for the provider caps (cumulative; the server stops the turn when the cap is reached)
          usageSentAt = Date.now();
          this.deps.send('run.usage', { kind: 'chat', id: msg.chatId, usage: ev.usage });
        }
        if (ev.kind === 'session') {
          sessionId = ev.runtimeSessionId;
          chat.runtimeSessionId = ev.runtimeSessionId;
        } else if (ev.kind === 'delta') {
          streamed += ev.text;
          if (segments[segments.length - 1]?.type !== 'text') startText();
          const last = segments[segments.length - 1];
          if (last?.type === 'text') last.text += ev.text;
          this.deps.send('chat.delta', { chatId: msg.chatId, threadId: msg.threadId, text: ev.text });
        } else if (ev.kind === 'textstart') startText();
        else if (ev.kind === 'thinking') {
          segments.push({ type: 'thinking' });
          activity(segments.length - 1, { type: 'thinking' });
        } else if (ev.kind === 'final') finalText = ev.text;
        else if (ev.kind === 'tool') {
          this.countTool(ev, counts, commands);
          // the segment is stored and shown: every tool summary goes through the same redaction as the audit
          const summary = redactCommand(ev.summary).slice(0, 500);
          const seg: ChatSegment = {
            type: 'tool',
            ...(ev.id ? { id: ev.id } : {}),
            name: ev.name,
            ...(summary ? { summary } : {}),
            status: 'running',
          };
          segments.push(seg);
          if (ev.id) toolAt.set(ev.id, segments.length - 1);
          activity(segments.length - 1, seg);
        } else if (ev.kind === 'toolresult') {
          const i = toolAt.get(ev.id);
          const seg = i === undefined ? undefined : segments[i];
          if (i !== undefined && seg?.type === 'tool') {
            seg.status = ev.refused ? 'refused' : ev.isError ? 'error' : 'ok';
            activity(i, seg, true);
          }
        } else if (ev.kind === 'exit') exit = ev;
      }
    } finally {
      fenceNote = await fence();
    }

    // Native subagents this turn ran (Claude Code): booked as delegates of the turn from their transcripts.
    if (session.nativeSubagentUsage)
      await this.delegates
        .bookNative(this.delegateCaller(chat), session.nativeSubagentUsage())
        .catch((err) => this.log.warn(`could not book the subagents of chat ${msg.chatId}: ${String(err)}`));
    if (chat.stopReason) {
      this.error(msg, withFence(chat.stopReason));
      return fenceNote;
    }
    if (exit.code !== 0) {
      if (exit.authFailed)
        this.error(
          msg,
          withFence(
            'The Claude login on this workstation has expired. On that machine run `claude`, then `/login`; this conversation works again once you have.',
          ),
        );
      else if (exit.usageLimit)
        this.error(
          msg,
          withFence(
            `The Claude usage limit on this workstation has been reached. Conversations and agents work again at ${formatLimitTime(new Date(exit.usageLimit.until))}; nothing is lost, please try again then.`,
          ),
        );
      else
        this.error(
          msg,
          withFence(exit.error ?? `the ${msg.agent.runtime} process exited with code ${exit.code}`),
        );
      return fenceNote;
    }
    for (const seg of segments) if (seg.type === 'tool' && seg.status === 'running') seg.status = 'ok';
    const turn = segments.filter((x) => x.type !== 'text' || x.text.trim());
    if (!turn.some((x) => x.type === 'text') && (finalText ?? streamed).trim())
      turn.push({ type: 'text', text: finalText ?? streamed });
    const usage = session.usage() ?? zeroUsage();
    if (o.fullPower && commands.length) this.auditCommands(msg.chatId, commands);
    this.terminal(
      msg.chatId,
      this.deps.send('chat.done', {
        chatId: msg.chatId,
        threadId: msg.threadId,
        messageText: withFence(finalText ?? (chatSegmentsText(turn) || streamed)),
        // Additive: the whole turn in order (older servers ignore it).
        ...(turn.length ? { segments: capChatSegments(turn) } : {}),
        usage,
        ...(sessionId ? { runtimeSessionId: sessionId } : {}),
        // The server gets each command's first word and counts only; the full (redacted) text stays in a local audit file.
        ...(o.fullPower
          ? {
              toolCounts: counts,
              ...(commands.length ? { commands: summarizeCommandTexts(commands) } : {}),
            }
          : {}),
        ...(o.degraded ? { degraded: o.degraded } : {}),
        ...(o.permissionMode ? { permissionMode: o.permissionMode } : {}),
        ...(usage.model ? { model: usage.model } : {}),
      }),
    );
    return fenceNote;
  }

  /**
   * A turn of a discovery or boardroom session: one headless, read-only call as the speaker. The persona text comes with the
   * turn, or from this workstation's registry (a persona in the organization vault); the only command the speaker may run
   * is `aom`. The reply goes back as the usual `chat.done`, which the server stores as a message of the speaker.
   */
  private async runSessionTurn(chat: ActiveChat): Promise<void> {
    const { msg } = chat;
    const session = msg.session;
    if (!session) return;
    const { paths } = this.deps;
    const adapter = this.deps.adapters.get(msg.agent.runtime);
    const caps = adapter ? await adapter.capabilities() : undefined;
    if (!adapter?.startChat || !caps?.available || !mainOk(adapter, msg.agent.model))
      return this.error(
        msg,
        `runtime ${msg.agent.runtime} is not available for session turns on this workstation`,
      );
    // A persona that lives in the organization vault travels without its text: read it from the registry here.
    const stored = session.speaker.personaKey
      ? this.deps.capabilities?.persona(
          session.speaker.personaKey,
          undefined,
          msg.context.orgId,
          viewerOfChat(msg),
        )
      : undefined;
    const persona = session.instructions ?? stored?.body;
    if (session.speaker.kind === 'persona' && !persona)
      return this.error(
        msg,
        `persona "${session.speaker.personaKey ?? session.speaker.name}" was not found on this workstation`,
      );
    const spec = {
      ...session,
      speaker: {
        ...session.speaker,
        ...(session.speaker.stance || !stored ? {} : { stance: stored.meta.stance }),
        ...(session.speaker.voice || !stored ? {} : { voice: stored.meta.voice }),
      },
    };
    const sandbox = await ensureSandbox(
      paths,
      msg.agent.agentId,
      msg.agent.name,
      await resolveCommitIdentity(paths.root),
    );
    chat.sandbox = sandbox;
    chat.releaseTmp = holdAgentTmp(sandbox);
    const capIndex =
      this.deps.capabilities?.instructionsIndex(
        msg.agent.skills,
        undefined,
        msg.context.orgId,
        viewerOfChat(msg),
      ) ?? '';
    // A runtime with tools and no shell (the direct-model runtime) gets the same turn rendered for tools, with the call; the
    // others read `CLAUDE.md` from their config dir.
    const direct = adapter.instructionStyle === 'tools';
    // Delegation (R3b): the session's grants. A Claude Code turn also gets them as native subagents.
    const subagents =
      !direct && msg.agent.runtime === 'claude-code' && session.delegation?.targets.length
        ? await this.delegates.nativeSubagents(this.delegateCaller(chat))
        : [];
    const note = delegateNote(session.delegation, this.delegates.nativeNames(msg.chatId));
    const instructions = direct
      ? renderDirectSystemPrompt({
          session: { spec, persona: persona ?? '' },
          tools: sessionToolsFor(session.purpose, { delegate: !!session.delegation?.targets.length }),
          capabilityIndex: `${capIndex}${note ? `\n\n${note}` : ''}`,
        })
      : undefined;
    if (!direct)
      await adapter.writeInstructions(
        sandbox,
        `${renderSessionTurnInstructions(spec, persona ?? '', { scratchFiles: msg.agent.runtime === 'claude-code' })}${capIndex ? `\n\n${capIndex}\n` : ''}${note ? `\n\n${note}\n` : ''}`,
      );
    const tc = this.deps.toolchains?.resolve();
    const env = {
      ...sandboxEnv(sandbox, undefined, tc?.env),
      ...this.issueCredential(chat),
      PATH: tc ? agentPath(tc, paths.bin) : `${paths.bin}${delimiter}${process.env.PATH ?? ''}`,
    };
    chat.session = await adapter.startChat({
      chatId: msg.chatId,
      message: msg.message,
      cwd: sandbox.scratch,
      sandbox,
      agent: msg.agent,
      env,
      // read-only: the working folder is the agent's own scratch folder, which stays writable (drafts for --content-file);
      // the policy denies a read-only working folder only outside scratch
      readOnly: true,
      readDirs: [],
      ...(tc ? { toolchainReadDirs: tc.readDirs } : {}),
      context: msg.context,
      ...(msg.context.orgId ? { orgId: msg.context.orgId } : {}),
      sessionTurn: {
        kind: session.kind,
        speakerKind: session.speaker.kind,
        ...(session.speaker.personaKey ? { personaKey: session.speaker.personaKey } : {}),
        ...(session.purpose ? { purpose: session.purpose } : {}),
      },
      ...(instructions ? { instructions } : {}),
      ...(subagents.length ? { subagents } : {}),
      ...(direct && session.delegation?.targets.length ? { delegate: true } : {}),
      logFile: `${paths.shiftLogs}/chat-${msg.chatId}.jsonl`,
    });
    if (subagents.length && chat.session)
      this.delegates.attachNative(msg.chatId, {
        session: chat.session,
        configDir: sandbox.configDir,
        sessionId: () => chat.runtimeSessionId,
      });
    if (chat.stopReason) void chat.session.stop(`chat.${chat.stopReason}`);
    await this.finishTurn(chat, { fullPower: false });
  }

  /**
   * A plain chat on the direct-model runtime: a conversation with the model, its memory kept by the runner, and only the registry
   * and ledger tools. No repositories, no vault, no worktree, no shell: the instructions say so. The CEO's full-power owner turns
   * are never run here (they need Claude Code): a CEO chat on a direct model is a restricted conversation.
   */
  private async runDirectChat(chat: ActiveChat, adapter: RuntimeAdapter): Promise<void> {
    const { msg } = chat;
    const { paths } = this.deps;
    const caps = await adapter.capabilities();
    if (!adapter.startChat || !caps.available)
      return this.error(msg, `runtime ${msg.agent.runtime} is not available for chat on this workstation`);
    const sandbox = await ensureSandbox(
      paths,
      msg.agent.agentId,
      msg.agent.name,
      await resolveCommitIdentity(paths.root),
    );
    chat.sandbox = sandbox;
    chat.releaseTmp = holdAgentTmp(sandbox);
    const capIndex =
      this.deps.capabilities?.instructionsIndex(
        msg.agent.skills,
        undefined,
        msg.context.orgId,
        viewerOfChat(msg),
      ) ?? '';
    const instructions = renderDirectSystemPrompt({
      chat: { agent: msg.agent, context: msg.context },
      tools: chatToolsFor({
        playbook: !!msg.playbookGrants?.length,
        delegate: !!msg.delegation?.targets.length && this.mayDelegate(msg),
      }),
      capabilityIndex: `${capIndex}${this.mayDelegate(msg) && delegateNote(msg.delegation) ? `\n\n${delegateNote(msg.delegation)}` : ''}`,
    });
    const env = {
      ...sandboxEnv(sandbox),
      ...this.issueCredential(chat, { socket: false }),
    };
    chat.session = await adapter.startChat({
      chatId: msg.chatId,
      message: msg.ceoMode ? composeOwnerMessage(msg) : msg.message,
      cwd: sandbox.scratch,
      sandbox,
      agent: msg.agent,
      env,
      readOnly: true,
      context: msg.context,
      ...(msg.context.orgId ? { orgId: msg.context.orgId } : {}),
      instructions,
      ...(msg.playbookGrants?.length ? { playbookGrants: msg.playbookGrants } : {}),
      ...(msg.delegation?.targets.length && this.mayDelegate(msg) ? { delegate: true } : {}),
      ...(msg.resumeSessionId ? { resumeSessionId: msg.resumeSessionId } : {}),
      logFile: `${paths.shiftLogs}/chat-${msg.chatId}.jsonl`,
    });
    if (chat.stopReason) void chat.session.stop(`chat.${chat.stopReason}`);
    await this.finishTurn(chat, { fullPower: false });
  }

  private async run(chat: ActiveChat): Promise<void> {
    const { msg } = chat;
    const { paths } = this.deps;
    if (msg.session) return this.runSessionTurn(chat);
    const chosen = this.deps.adapters.get(msg.agent.runtime);
    if (chosen?.instructionStyle === 'tools') return this.runDirectChat(chat, chosen);
    const profile = selectChatProfile(msg, {
      fullPower: this.deps.ceoFullPower?.() ?? false,
      ...(this.deps.takeOwnerTurn ? { takeLocalTurn: this.deps.takeOwnerTurn } : {}),
    });
    if (profile.kind === 'refuse') return this.error(msg, profile.error);
    if (profile.kind === 'full') return this.runOwnerTurn(chat, profile.mode);
    const adapter = this.deps.adapters.get(msg.agent.runtime);
    const caps = adapter ? await adapter.capabilities() : undefined;
    if (
      !adapter?.startChat ||
      !caps?.available ||
      !mainOk(adapter, msg.agent.model, msg.account?.key ?? 'main')
    ) {
      this.error(msg, `runtime ${msg.agent.runtime} is not available for chat on this workstation`);
      return;
    }
    const sandbox = await ensureSandbox(
      paths,
      msg.agent.agentId,
      msg.agent.name,
      await resolveCommitIdentity(paths.root),
    );
    chat.sandbox = sandbox;
    chat.releaseTmp = holdAgentTmp(sandbox);
    const attachDir = cardAttachmentsDir(sandbox.tmp);
    mkdirSync(attachDir, { recursive: true });
    // A card in context: read its worktree (if this workstation has it) without being able to change it.
    const wt = chatWorktree(paths, msg.context);
    const devops = msg.agent.isDevops === true; // G-Q1: runs as the user, unsandboxed, like its shifts
    const hasWt = !devops && !!wt && existsSync(wt);
    // An @mention that may work (the server granted edit and/or shell): the card's folder is writable for this turn. Claude Code
    // only; the card's folder must be on this workstation, otherwise the mention cannot do what it was given tools for.
    const asksWork = msg.mentionWork === true && !devops && msg.agent.runtime === 'claude-code';
    const workTools = msg.agent.permissions.allowedTools.some((t) => t === 'edit' || t === 'shell');
    if (asksWork && workTools && !hasWt) {
      this.error(
        msg,
        "the card's working folder is not on this workstation, so the agent cannot work on it from a comment",
      );
      return;
    }
    const work = asksWork && workTools && hasWt;
    const readOnly = hasWt && !work;
    if (work && wt) chat.releaseWorktree = holdWorktree(wt, `chat:${msg.chatId}`);
    // gate-fixes-2 D2: a mention that works writes the clone's .git (its own branch): a writer until the turn ends
    if (work && wt) chat.releaseWriter = await writerStart(wt);
    const cwd = hasWt && wt ? wt : sandbox.scratch;
    // Repositories this chat may read (read-only): the project's reference repositories, and when there is no card
    // worktree here also the project's own clones (a chat about the project, or about a card not started here). The
    // DevOps engineer reads anywhere anyway. Only clones this runner found itself are opened.
    const registered =
      devops || !this.deps.findRepo
        ? []
        : (
            await resolveReadRepos(
              msg.context.readRepos,
              {
                findRepo: this.deps.findRepo,
                ...(this.deps.findLocal ? { findLocal: this.deps.findLocal } : {}),
                runnerRoot: paths.root,
              },
              msg.context.localReadRepos,
            )
          ).filter((r) => !(readOnly || work) || r.kind !== 'project');
    // A role that reads the organization's code (the architect) also reads the organization source folder, read-only.
    const orgId = msg.context.orgId;
    const fromFolder =
      !devops && msg.agent.permissions.readOrgRepos && orgId
        ? await resolveOrgFolderRepos(this.deps.orgSourceFolder?.(orgId), {
            repoRoots: this.deps.repoRoots?.() ?? [],
            runnerRoot: paths.root,
          })
        : [];
    // The knowledge vault of this chat (read-only): its clone is a read-only folder like a reference repository (secret
    // files blocked); no clone here: the instructions say so. The DevOps engineer reads anywhere anyway.
    const vaultCtx =
      !devops && msg.context.vault ? await readVaultContext(paths.vaults, msg.context.vault) : null;
    const vaultFolder: ReadableFolder[] = vaultCtx
      ? [
          {
            name: msg.context.vault?.kind === 'org' ? 'organization' : 'project',
            path: vaultCtx.addDir,
            kind: 'vault',
          },
        ]
      : [];
    const folders = mergeReadFolders(mergeReadFolders(registered, fromFolder), vaultFolder);

    const signIn = devops ? '' : (this.deps.mcpSignInNote?.(msg.context.mcpServers) ?? '');
    // The project's code graph (read-only verbs): only when this workstation can read it and the chat is not the holdout.
    const gs = msg.context.graph;
    const graphNote = gs && gs.arm === 'on' && this.deps.graph?.()?.load(gs) ? `\n${CHAT_GRAPH_NOTE}\n` : '';
    const capIndex =
      this.deps.capabilities?.instructionsIndex(
        msg.agent.skills,
        msg.context.projectId,
        msg.context.orgId,
        viewerOfChat(msg),
      ) ?? '';
    // Delegation (R3b): the agent's grants; a Claude Code chat also gets them as native subagents (read only, like the chat).
    // review S3: the toolchains are resolved once per turn (each resolve checks the Guildwise tool folder)
    const tc = this.deps.toolchains?.resolve();
    chat.delegateWork = {
      cwd,
      readDirs: folders.map((f) => f.path),
      ...(tc ? { toolchainReadDirs: tc.readDirs } : {}),
    };
    const subagents =
      !devops &&
      this.mayDelegate(msg) &&
      msg.agent.runtime === 'claude-code' &&
      msg.delegation?.targets.length
        ? await this.delegates.nativeSubagents(this.delegateCaller(chat))
        : [];
    const note =
      !devops && this.mayDelegate(msg)
        ? delegateNote(msg.delegation, this.delegates.nativeNames(msg.chatId))
        : '';
    const grantedSkills =
      this.deps.capabilities?.grantedSkills(
        msg.agent.skills,
        msg.context.projectId,
        msg.context.orgId,
        viewerOfChat(msg),
        { packScriptsGated: msg.agent.packScriptsGated === true },
      ) ?? [];
    await adapter.writeInstructions(
      sandbox,
      `${signIn ? `${signIn}\n` : ''}${graphNote}${capIndex ? `${capIndex}\n\n` : ''}${note ? `${note}\n\n` : ''}${playbookNote(msg.playbookGrants) ? `${playbookNote(msg.playbookGrants)}\n\n` : ''}${renderChatInstructions(
        msg.agent,
        msg.context,
        {
          jiraSkill: await this.jiraSkill(msg),
          readFolders: folders,
          // gate-fixes-2 F7b: a work mention is told it may change the card's folder, not "scratch only"
          ...(work && wt ? { work: { folder: wt } } : {}),
          ...(!devops && msg.context.vault
            ? {
                vault: vaultCtx
                  ? { projectDoc: vaultCtx.projectDoc, standingOrders: vaultCtx.standingOrders }
                  : { missing: true },
              }
            : {}),
        },
      )}`,
    );
    const baseEnv = {
      ...sandboxEnv(sandbox, undefined, tc?.env),
      ...this.issueCredential(chat),
      PATH: tc ? agentPath(tc, paths.bin) : `${paths.bin}${delimiter}${process.env.PATH ?? ''}`,
    };
    // T4: a DevOps chat always runs installs with scripts off (it names no repository the owner allowed)
    const env = devops ? withInstallScriptsOff(baseEnv) : baseEnv;
    await this.fenceStart(chat);
    chat.session = await adapter.startChat({
      chatId: msg.chatId,
      message: msg.ceoMode ? composeOwnerMessage(msg) : msg.message,
      cwd,
      sandbox,
      agent: msg.agent,
      env,
      readOnly,
      ...(work ? { work: true } : {}),
      readDirs: folders.map((f) => f.path),
      ...(tc ? { toolchainReadDirs: tc.readDirs } : {}),
      context: msg.context,
      ...(msg.context.orgId ? { orgId: msg.context.orgId } : {}),
      // Skills this agent's role grants, loaded natively by a runtime that has them (never for the CEO's conversation or DevOps).
      ...(!devops && msg.agent.roleKey !== 'ceo' ? { grantedSkills } : {}),
      ...(msg.context.intake ? { intake: true } : {}),
      ...(msg.resumeSessionId ? { resumeSessionId: msg.resumeSessionId } : {}),
      // the account the server chose for a chat about a project's card (absent: main)
      ...(msg.account && msg.account.key !== 'main' ? { account: msg.account.key } : {}),
      ...(chat.devopsBox ? { devopsBox: true } : {}),
      ...(devops && !chat.devopsBox
        ? {
            devopsGuard: {
              sessionRef: msg.chatId,
              installScriptsOff: true,
              // T10: the workstation's switches, narrowed by policy.json; an older server sends none: all off
              access: chatDevopsAccess(msg.devopsAccess, this.deps.narrowAccess),
            },
          }
        : {}),
      ...(subagents.length ? { subagents } : {}),
      logFile: `${paths.shiftLogs}/chat-${msg.chatId}.jsonl`,
    });
    if (subagents.length && chat.session)
      this.delegates.attachNative(msg.chatId, {
        session: chat.session,
        configDir: sandbox.configDir,
        sessionId: () => chat.runtimeSessionId,
      });
    if (chat.stopReason) void chat.session.stop(`chat.${chat.stopReason}`); // cancelled while starting

    await this.finishTurn(chat, {
      fullPower: false,
      ...(profile.kind === 'degraded' ? { degraded: profile.degraded } : {}),
    });
  }
}

/**
 * The card worktree a chat may read: the path the server knows for the card (old or new layout), else the default
 * location. Either way it must lie inside this runner's `worktrees/` directory.
 */
function chatWorktree(paths: RunnerPaths, c: ChatContext): string | undefined {
  const candidate =
    c.cardWorktreePath ??
    (c.projectKey && c.cardRef ? paths.worktreePath(c.projectKey, c.cardRef, c.projectId) : undefined);
  if (!candidate) return undefined;
  try {
    return confine(paths.worktrees, candidate);
  } catch {
    return undefined;
  }
}
