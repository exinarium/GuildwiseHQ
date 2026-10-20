import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  type ChatContext,
  type IpcReportRequest,
  type IpcReportResponse,
  type IpcRpcRequest,
  type IpcRpcResponse,
  JIRA_SKILL_PATH,
  type ReadableFolder,
  renderChatInstructions,
  type ServerToRunnerOf,
  type ToolCounts,
  type Usage,
} from '@aom/shared';
import { formatLimitTime } from '../adapters/claude-usage-limit.ts';
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
import { type GuardClone, markJobStarted } from '../ceo/guard-hook.ts';
import { selectChatProfile } from '../ceo/profile.ts';
import { composeOwnerMessage, removeTurnDir, turnDirOf, writeTurnFiles } from '../ceo/turn-files.ts';
import { recordDevopsAudit } from '../devops/audit.ts';
import { redactCommand } from '../devops/guard.ts';
import { type ExternalAdapters, formatSource, readScopedJira } from '../external/index.ts';
import { confine } from '../fs-safe.ts';
import { resolveCommitIdentity } from '../git/identity.ts';
import { CHAT_GRAPH_NOTE } from '../graph/brief.ts';
import type { GraphService } from '../graph/service.ts';
import type { IpcServer, ShiftIpcHandler } from '../ipc/server.ts';
import { type Logger, nullLogger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import { mergeReadFolders, resolveOrgFolderRepos, resolveReadRepos } from '../read-repos.ts';
import type { RestartAfterReply } from '../restart-after-reply.ts';
import { cleanAgentTmp, ensureSandbox, holdAgentTmp, type Sandbox, sandboxEnv } from '../sandbox/sandbox.ts';
import { agentPath, type ToolchainRegistry, toolchainRpc } from '../toolchain/registry.ts';
import { readVaultContext } from '../vaults/context.ts';

type ChatStartMsg = ServerToRunnerOf<'chat.start'>;

export interface ChatDeps {
  /** The project graph (`aom graph query|explain` in a chat). Absent: none. */
  graph?: () => GraphService | undefined;
  paths: RunnerPaths;
  adapters: Map<string, RuntimeAdapter>;
  ipc: IpcServer;
  log?: Logger;
  /** Acked types (`chat.done`, `chat.error`) go through the outbox; `chat.delta` is dropped while offline. */
  send(
    type: 'chat.delta' | 'chat.done' | 'chat.error' | 'devops.audit',
    payload: Record<string, unknown>,
  ): string | undefined;
  /** The local opt-in `aom-runner ceo full-power on`, read fresh at each turn (default: off). */
  ceoFullPower?: () => boolean;
  /** The repository clones on this workstation (the use-the-system hook nudges edits inside them). */
  guardClones?: () => GuardClone[];
  /** `aom runner restart` in an owner turn: the restart that waits for the reply to be acknowledged. */
  restart?: RestartAfterReply;
  /** `aom sudo` in the DevOps engineer's chat: runs a command with administrator rights (the stored password stays here). */
  sudoRun?: (cmd: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
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
  session?: RuntimeSession;
  token?: string;
  sandbox?: Sandbox;
  releaseTmp?: () => void;
  stopReason?: 'cancelled' | string;
  /** A CEO owner or order turn in the full-power profile: it survives a dropped connection. */
  fullPower?: 'owner' | 'order';
  turnDir?: string;
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

const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/**
 * Runs chat conversations on the agent's workstation (docs/ARCHITECTURE.md section 14): one headless call per user
 * message in the agent's sandbox, streamed back as `chat.delta` and finished with `chat.done` (or `chat.error`).
 * Chats never claim cards and do not count against the shift capacity.
 */
export class ChatManager {
  private readonly active = new Map<string, ActiveChat>();
  /** Chats that ran to an end in this process: a redelivered `chat.start` of one is ignored. */
  private readonly recent = new Set<string>();
  private readonly log: Logger;

  constructor(readonly deps: ChatDeps) {
    this.log = deps.log ?? nullLogger;
  }

  get size(): number {
    return this.active.size;
  }

  /** The chats running right now (announced in `hello.activeChats`). */
  activeIds(): string[] {
    return [...this.active.keys()];
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

  private error(msg: ChatStartMsg, error: string): void {
    this.terminal(
      msg.chatId,
      this.deps.send('chat.error', { chatId: msg.chatId, threadId: msg.threadId, error }),
    );
  }

  async handleStart(msg: ChatStartMsg): Promise<void> {
    if (this.active.has(msg.chatId) || this.recent.has(msg.chatId)) return; // redelivery
    const chat: ActiveChat = { msg };
    this.active.set(msg.chatId, chat);
    try {
      await this.run(chat);
    } catch (err) {
      this.log.error(`chat ${msg.chatId} failed unexpectedly`, err);
      this.error(msg, err instanceof Error ? err.message : String(err));
    } finally {
      if (chat.token) this.deps.ipc.revoke(chat.token);
      this.active.delete(msg.chatId);
      this.remember(msg.chatId);
      if (chat.turnDir) removeTurnDir(chat.turnDir);
      this.deps.restart?.turnFinished(msg.chatId, this.terminalFrames.get(msg.chatId));
      chat.releaseTmp?.();
      if (chat.sandbox) await cleanAgentTmp(chat.sandbox.tmp);
    }
  }

  async handleCancel(chatId: string): Promise<void> {
    const c = this.active.get(chatId);
    if (!c) return;
    c.stopReason ??= 'cancelled';
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

  private handlerFor(chat: ActiveChat): ShiftIpcHandler {
    const { chatId } = chat.msg;
    return {
      report: async (req: IpcReportRequest): Promise<IpcReportResponse> => {
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
        // `aom sudo -- <command>` in the DevOps engineer's chat: the runner runs it with the stored password (the
        // always-refused rules of the guard still apply to the command: the hook judged it before `aom` ran).
        if (req.method === 'sudo.run') return this.sudoRun(chat, req.params);
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
   * `aom sudo -- <command>` in the DevOps engineer's chat. The owner is in the conversation, so there is no separate grant
   * to check; the stored password exists only when the owner set it on this workstation (the runner refuses without it).
   */
  private async sudoRun(chat: ActiveChat, params: Record<string, unknown>): Promise<IpcRpcResponse> {
    if (!chat.msg.agent.isDevops) return { ok: false, error: 'only the DevOps engineer may use sudo' };
    const argv = Array.isArray(params.argv) ? params.argv.map(String) : [];
    if (argv.length === 0 || !this.deps.sudoRun)
      return { ok: false, error: 'usage: aom sudo -- <command> [args...]' };
    const [cmd, ...args] = argv as [string, ...string[]];
    const r = await this.deps.sudoRun(cmd, args);
    return {
      ok: true,
      result: { exitCode: r.exitCode, stdout: r.stdout.slice(-20000), stderr: r.stderr.slice(-8000) },
    };
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
    if (!adapter?.startOwnerTurn || !caps?.available)
      return this.error(
        msg,
        `runtime ${msg.agent.runtime} is not available for the CEO's full-power turns on this workstation`,
      );
    chat.fullPower = mode;
    const turnDir = turnDirOf(paths.root, msg.chatId);
    chat.turnDir = turnDir;
    chat.token = this.deps.ipc.registerShift(this.handlerFor(chat));
    const ipcEnv: Record<string, string> = {
      AOM_IPC_URL: this.deps.ipc.url,
      ...(this.deps.ipc.socketPath ? { AOM_IPC_SOCKET: this.deps.ipc.socketPath } : {}),
      AOM_SHIFT_TOKEN: chat.token,
    };
    writeTurnFiles({
      turnDir,
      brief: msg.context.ceo?.brief ?? '',
      mode,
      ipcEnv,
      runnerRoots: [paths.root],
      pid: process.pid,
      clones: this.deps.guardClones?.() ?? [],
    });
    const cwd = msg.cwd && existsSync(msg.cwd) ? msg.cwd : homedir();
    chat.session = await adapter.startOwnerTurn({
      chatId: msg.chatId,
      mode,
      message: composeOwnerMessage(msg),
      cwd,
      agent: msg.agent,
      env: {
        ...ipcEnv,
        AOM_SHIFT_ID: msg.chatId,
        AOM_CEO_TURN_DIR: turnDir,
        PATH: `${paths.bin}${delimiter}${process.env.PATH ?? ''}`,
      },
      turnDir,
      ...(msg.resumeSessionId ? { resumeSessionId: msg.resumeSessionId } : {}),
      ...(msg.addDirs?.length ? { addDirs: msg.addDirs } : {}),
      logFile: `${paths.shiftLogs}/chat-${msg.chatId}.jsonl`,
    });
    if (chat.stopReason) void chat.session.stop(`chat.${chat.stopReason}`);
    await this.finishTurn(chat, { fullPower: true });
  }

  /** Reads a session to its end and reports it: `chat.done` (or `chat.error`). */
  private async finishTurn(chat: ActiveChat, o: { fullPower: boolean; degraded?: string }): Promise<void> {
    const { msg } = chat;
    const session = chat.session;
    if (!session) return;
    let sessionId: string | undefined;
    let streamed = '';
    let finalText: string | undefined;
    const counts: ToolCounts = { bash: 0, edit: 0, mcp: 0, other: 0 };
    const commands: string[] = [];
    let exit: {
      code: number | null;
      error?: string;
      authFailed?: boolean;
      usageLimit?: { until: string };
    } = { code: null };
    for await (const ev of session.events()) {
      if (ev.kind === 'session') sessionId = ev.runtimeSessionId;
      else if (ev.kind === 'delta') {
        streamed += ev.text;
        this.deps.send('chat.delta', { chatId: msg.chatId, threadId: msg.threadId, text: ev.text });
      } else if (ev.kind === 'final') finalText = ev.text;
      else if (ev.kind === 'tool') this.countTool(ev, counts, commands);
      else if (ev.kind === 'exit') exit = ev;
    }

    if (chat.stopReason) return this.error(msg, chat.stopReason);
    if (exit.code !== 0) {
      if (exit.authFailed)
        return this.error(
          msg,
          'The Claude login on this workstation has expired. On that machine run `claude`, then `/login`; this conversation works again once you have.',
        );
      if (exit.usageLimit)
        return this.error(
          msg,
          `The Claude usage limit on this workstation has been reached. Conversations and agents work again at ${formatLimitTime(new Date(exit.usageLimit.until))}; nothing is lost, please try again then.`,
        );
      return this.error(msg, exit.error ?? `the ${msg.agent.runtime} process exited with code ${exit.code}`);
    }
    const usage = session.usage() ?? zeroUsage();
    this.terminal(
      msg.chatId,
      this.deps.send('chat.done', {
        chatId: msg.chatId,
        threadId: msg.threadId,
        messageText: finalText ?? streamed,
        usage,
        ...(sessionId ? { runtimeSessionId: sessionId } : {}),
        ...(o.fullPower ? { toolCounts: counts, ...(commands.length ? { commands } : {}) } : {}),
        ...(o.degraded ? { degraded: o.degraded } : {}),
        ...(usage.model ? { model: usage.model } : {}),
      }),
    );
  }

  private async run(chat: ActiveChat): Promise<void> {
    const { msg } = chat;
    const { paths } = this.deps;
    const profile = selectChatProfile(msg, { fullPower: this.deps.ceoFullPower?.() ?? false });
    if (profile.kind === 'refuse') return this.error(msg, profile.error);
    if (profile.kind === 'full') return this.runOwnerTurn(chat, profile.mode);
    const adapter = this.deps.adapters.get(msg.agent.runtime);
    const caps = adapter ? await adapter.capabilities() : undefined;
    if (!adapter?.startChat || !caps?.available) {
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
    const readOnly = !devops && !!wt && existsSync(wt);
    const cwd = readOnly && wt ? wt : sandbox.scratch;
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
          ).filter((r) => !readOnly || r.kind !== 'project');
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
    await adapter.writeInstructions(
      sandbox,
      `${signIn ? `${signIn}\n` : ''}${graphNote}${renderChatInstructions(msg.agent, msg.context, {
        jiraSkill: await this.jiraSkill(msg),
        readFolders: folders,
        ...(!devops && msg.context.vault
          ? {
              vault: vaultCtx
                ? { projectDoc: vaultCtx.projectDoc, standingOrders: vaultCtx.standingOrders }
                : { missing: true },
            }
          : {}),
      })}`,
    );
    chat.token = this.deps.ipc.registerShift(this.handlerFor(chat));
    const tc = this.deps.toolchains?.resolve();
    const env = {
      ...sandboxEnv(sandbox, undefined, tc?.env),
      AOM_IPC_URL: this.deps.ipc.url,
      ...(this.deps.ipc.socketPath ? { AOM_IPC_SOCKET: this.deps.ipc.socketPath } : {}),
      AOM_SHIFT_TOKEN: chat.token,
      AOM_SHIFT_ID: msg.chatId,
      PATH: tc ? agentPath(tc, paths.bin) : `${paths.bin}${delimiter}${process.env.PATH ?? ''}`,
    };
    chat.session = await adapter.startChat({
      chatId: msg.chatId,
      message: msg.ceoMode ? composeOwnerMessage(msg) : msg.message,
      cwd,
      sandbox,
      agent: msg.agent,
      env,
      readOnly,
      readDirs: folders.map((f) => f.path),
      ...(tc ? { toolchainReadDirs: tc.readDirs } : {}),
      context: msg.context,
      ...(msg.context.intake ? { intake: true } : {}),
      ...(msg.resumeSessionId ? { resumeSessionId: msg.resumeSessionId } : {}),
      ...(devops ? { devopsGuard: { sessionRef: msg.chatId } } : {}),
      logFile: `${paths.shiftLogs}/chat-${msg.chatId}.jsonl`,
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
