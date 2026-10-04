import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import {
  type ChatContext,
  type IpcReportRequest,
  type IpcReportResponse,
  type IpcRpcRequest,
  type IpcRpcResponse,
  JIRA_SKILL_PATH,
  renderChatInstructions,
  type ServerToRunnerOf,
  type Usage,
} from '@aom/shared';
import type { RuntimeAdapter, RuntimeSession } from '../adapters/types.ts';
import { type ExternalAdapters, formatSource } from '../external/index.ts';
import { confine } from '../fs-safe.ts';
import type { IpcServer, ShiftIpcHandler } from '../ipc/server.ts';
import { type Logger, nullLogger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import { ensureSandbox, sandboxEnv } from '../sandbox/sandbox.ts';

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
  /** RPC to the server under the chat's id (the server treats a chat as a shift of kind `chat`). */
  rpc(chatId: string, method: string, params: Record<string, unknown>): Promise<IpcRpcResponse>;
}

interface ActiveChat {
  msg: ChatStartMsg;
  session?: RuntimeSession;
  token?: string;
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
  /** M10: the BA's design chat (the server only allows these in the owner's chat with their BA). */
  'org.catalogue',
  'org.role.draft',
  'org.workflow.draft',
  'org.validate',
  'org.submit',
  'org.department',
]);

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
        if (req.method === 'source.read') return this.readSource(req.params);
        return CHAT_RPC.has(req.method)
          ? this.deps.rpc(chatId, req.method, req.params)
          : { ok: false, error: `${req.method} is not available in a chat conversation` };
      },
    };
  }

  /** The manager's own Jira skill (`skills/jira.md` in their work vault) replaces the built-in text in an intake chat. */
  private async jiraSkill(msg: ChatStartMsg): Promise<string | undefined> {
    const vaultId = msg.context.intake?.workVaultId;
    if (!vaultId) return undefined;
    try {
      const file = join(this.deps.paths.vaults, vaultId, ...JIRA_SKILL_PATH.split('/'));
      return existsSync(file) ? await readFile(file, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  }

  /** `aom source read --ref <ticket>`: read a ticket on this workstation (GitHub through `gh`; Jira is the agent's skill). */
  private async readSource(params: Record<string, unknown>): Promise<IpcRpcResponse> {
    const ref = String(params.ref ?? '').trim();
    if (!ref) return { ok: false, error: 'usage: aom source read --ref <owner/repo#12>' };
    if (!this.deps.external) return { ok: false, error: 'this runner has no ticket adapters' };
    try {
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
    const sandbox = await ensureSandbox(paths, msg.agent.agentId, msg.agent.name);
    // A card in context: read its worktree (if this workstation has it) without being able to change it.
    const wt = chatWorktree(paths, msg.context);
    const readOnly = !!wt && existsSync(wt);
    const cwd = readOnly && wt ? wt : sandbox.scratch;

    await adapter.writeInstructions(
      sandbox,
      renderChatInstructions(msg.agent, msg.context, { jiraSkill: await this.jiraSkill(msg) }),
    );
    chat.token = this.deps.ipc.registerShift(this.handlerFor(chat));
    const env = {
      ...sandboxEnv(sandbox),
      AOM_IPC_URL: this.deps.ipc.url,
      ...(this.deps.ipc.socketPath ? { AOM_IPC_SOCKET: this.deps.ipc.socketPath } : {}),
      AOM_SHIFT_TOKEN: chat.token,
      AOM_SHIFT_ID: msg.chatId,
      PATH: `${paths.bin}${delimiter}${process.env.PATH ?? ''}`,
    };
    chat.session = await adapter.startChat({
      chatId: msg.chatId,
      message: msg.message,
      cwd,
      sandbox,
      agent: msg.agent,
      env,
      readOnly,
      context: msg.context,
      ...(msg.context.intake ? { intake: true } : {}),
      ...(msg.resumeSessionId ? { resumeSessionId: msg.resumeSessionId } : {}),
      logFile: `${paths.shiftLogs}/chat-${msg.chatId}.jsonl`,
    });
    if (chat.stopReason) void chat.session.stop(`chat.${chat.stopReason}`); // cancelled while starting

    let sessionId: string | undefined;
    let streamed = '';
    let finalText: string | undefined;
    let exit: { code: number | null; error?: string } = { code: null };
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
