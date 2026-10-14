import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  type Usage,
} from '@aom/shared';
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
import { type ExternalAdapters, formatSource, readScopedJira } from '../external/index.ts';
import { confine } from '../fs-safe.ts';
import { resolveCommitIdentity } from '../git/identity.ts';
import type { IpcServer, ShiftIpcHandler } from '../ipc/server.ts';
import { type Logger, nullLogger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import { mergeReadFolders, resolveOrgFolderRepos, resolveReadRepos } from '../read-repos.ts';
import { ensureSandbox, type Sandbox, sandboxEnv } from '../sandbox/sandbox.ts';
import { agentPath, type ToolchainRegistry, toolchainRpc } from '../toolchain/registry.ts';
import { readVaultContext } from '../vaults/context.ts';

type ChatStartMsg = ServerToRunnerOf<'chat.start'>;

export interface ChatDeps {
  paths: RunnerPaths;
  adapters: Map<string, RuntimeAdapter>;
  ipc: IpcServer;
  log?: Logger;
  /** Acked types (`chat.done`, `chat.error`) go through the outbox; `chat.delta` is dropped while offline. */
  send(type: 'chat.delta' | 'chat.done' | 'chat.error', payload: Record<string, unknown>): void;
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
  stopReason?: 'cancelled' | string;
}

/**
 * Chat verbs a conversation may use (chat-scoped token): `ledger search`, `comment`, and reading the thread; the BA's
 * intake adds drafting cards and mapping the ticket (the server only allows those in an intake chat).
 */
const CHAT_RPC = new Set([
  'ledger.search',
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
  private readonly log: Logger;

  constructor(readonly deps: ChatDeps) {
    this.log = deps.log ?? nullLogger;
  }

  get size(): number {
    return this.active.size;
  }

  private error(msg: ChatStartMsg, error: string): void {
    this.deps.send('chat.error', { chatId: msg.chatId, threadId: msg.threadId, error });
  }

  async handleStart(msg: ChatStartMsg): Promise<void> {
    if (this.active.has(msg.chatId)) return; // redelivery
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
    }
  }

  async handleCancel(chatId: string): Promise<void> {
    const c = this.active.get(chatId);
    if (!c) return;
    c.stopReason ??= 'cancelled';
    await c.session?.stop('chat.cancel');
  }

  /** The connection dropped: the server fails these chats too; the error reaches it through the outbox. */
  async cancelAll(reason: string): Promise<void> {
    await Promise.all(
      [...this.active.values()].map(async (c) => {
        c.stopReason ??= reason;
        await c.session?.stop(`chat.${reason}`);
      }),
    );
  }

  private handlerFor(chat: ActiveChat): ShiftIpcHandler {
    const { chatId } = chat.msg;
    return {
      report: async (req: IpcReportRequest): Promise<IpcReportResponse> => {
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
        if (req.method === 'ceo')
          return chat.msg.agent.roleKey === 'ceo'
            ? this.deps.rpc(chatId, req.method, req.params)
            : { ok: false, error: 'not_ceo: only the CEO may use `aom ceo`' };
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
        if (req.method === 'git.status' || req.method === 'git.connect')
          return chat.msg.agent.isDevops && this.deps.git
            ? this.deps.git.handle(req.method, req.params)
            : { ok: false, error: 'only the DevOps engineer can use `aom git`' };
        return CHAT_RPC.has(req.method) || (chat.msg.agent.isDevops && DEVOPS_CHAT_RPC.has(req.method))
          ? this.deps.rpc(chatId, req.method, req.params)
          : { ok: false, error: `${req.method} is not available in a chat conversation` };
      },
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

  private async run(chat: ActiveChat): Promise<void> {
    const { msg } = chat;
    const { paths } = this.deps;
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
    await adapter.writeInstructions(
      sandbox,
      `${signIn ? `${signIn}\n` : ''}${renderChatInstructions(msg.agent, msg.context, {
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
      message: msg.message,
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
      logFile: `${paths.shiftLogs}/chat-${msg.chatId}.jsonl`,
    });
    if (chat.stopReason) void chat.session.stop(`chat.${chat.stopReason}`); // cancelled while starting

    let sessionId: string | undefined;
    let streamed = '';
    let finalText: string | undefined;
    let exit: { code: number | null; error?: string; authFailed?: boolean } = { code: null };
    for await (const ev of chat.session.events()) {
      if (ev.kind === 'session') sessionId = ev.runtimeSessionId;
      else if (ev.kind === 'delta') {
        streamed += ev.text;
        this.deps.send('chat.delta', { chatId: msg.chatId, threadId: msg.threadId, text: ev.text });
      } else if (ev.kind === 'final') finalText = ev.text;
      else if (ev.kind === 'exit') exit = ev;
    }

    if (chat.stopReason) return this.error(msg, chat.stopReason);
    if (exit.code !== 0) {
      if (exit.authFailed)
        return this.error(
          msg,
          'The Claude login on this workstation has expired. On that machine run `claude`, then `/login`; this conversation works again once you have.',
        );
      return this.error(msg, exit.error ?? `the ${msg.agent.runtime} process exited with code ${exit.code}`);
    }
    this.deps.send('chat.done', {
      chatId: msg.chatId,
      threadId: msg.threadId,
      messageText: finalText ?? streamed,
      usage: chat.session.usage() ?? zeroUsage(),
      ...(sessionId ? { runtimeSessionId: sessionId } : {}),
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
