import { CEO_PERMISSION_TIMEOUT_MS, type IpcRpcResponse } from '@aom/shared';
import { redactCommand } from '../devops/guard.ts';

/**
 * The permission relay (docs/design/ceo-front-door.md section 3.5, owner decision 14.1): a tiny stdio MCP server whose one tool
 * (`ask`, so `mcp__aom_permission__ask`) is Claude Code's `--permission-prompt-tool`. When the session needs a permission it
 * lacks, the relay raises the desk question "authorize this execution" (rpc `ceo` op `permission`), polls for the answer
 * and answers Claude Code: allow once, allow for the rest of the turn, or deny (also after 10 minutes). In an `order` turn
 * the question is raised but the turn does not wait: the step is denied at once and reported as waiting.
 */

export type RelayRpc = (params: Record<string, unknown>) => Promise<IpcRpcResponse>;

export interface RelayDeps {
  rpc: RelayRpc;
  mode: 'owner' | 'order';
  /** Poll interval (default 2 s). */
  pollMs?: number;
  /** Give up after this long (default 10 minutes). */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const RELAY_TOOL = 'ask';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export type Decision = { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string };

/** The tool input as shown on the desk: redacted, one string, at most 4000 characters. */
export function describeInput(input: unknown): string {
  let s: string;
  if (isObj(input) && typeof input.command === 'string') s = input.command;
  else {
    try {
      s = JSON.stringify(input) ?? '';
    } catch {
      s = String(input);
    }
  }
  return redactCommand(s).slice(0, 4000);
}

export class PermissionRelay {
  /** Tools the Owner allowed "for this turn". */
  private readonly turnAllowed = new Set<string>();
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: RelayDeps) {
    this.pollMs = deps.pollMs ?? 2000;
    this.timeoutMs = deps.timeoutMs ?? CEO_PERMISSION_TIMEOUT_MS;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  /** One permission request of Claude Code: `{tool_name, input, tool_use_id}`. */
  async decide(args: { tool_name?: unknown; input?: unknown; reason?: unknown }): Promise<Decision> {
    const tool = typeof args.tool_name === 'string' ? args.tool_name : 'unknown tool';
    const input = args.input;
    if (this.turnAllowed.has(tool)) return { behavior: 'allow', updatedInput: input ?? {} };
    const asked = await this.deps.rpc({
      op: 'permission',
      sub: 'ask',
      tool,
      input: describeInput(input),
      reason: typeof args.reason === 'string' ? args.reason.slice(0, 1000) : '',
    });
    const askId = asked.ok ? (asked.result as { askId?: string } | undefined)?.askId : undefined;
    if (!askId)
      return { behavior: 'deny', message: `Could not ask for authorization: ${asked.error ?? 'no answer'}.` };
    if (this.deps.mode === 'order')
      return {
        behavior: 'deny',
        message:
          'This step needs authorization and is waiting on the desk (an Owner or Admin can authorize it there). Do not retry it or work around it: list it as waiting in `aom ceo order done`.',
      };
    const started = this.now();
    for (;;) {
      const r = await this.deps.rpc({ op: 'permission', sub: 'poll', askId });
      const status = r.ok ? (r.result as { status?: string } | undefined)?.status : undefined;
      if (status === 'once') return { behavior: 'allow', updatedInput: input ?? {} };
      if (status === 'turn') {
        this.turnAllowed.add(tool);
        return { behavior: 'allow', updatedInput: input ?? {} };
      }
      if (status === 'deny')
        return { behavior: 'deny', message: 'The owner did not authorize this execution.' };
      if (status === 'timeout')
        return {
          behavior: 'deny',
          message: 'Nobody authorized this execution in time (it counts as denied).',
        };
      if (this.now() - started >= this.timeoutMs)
        return {
          behavior: 'deny',
          message: 'Nobody authorized this execution in time (it counts as denied).',
        };
      await this.sleep(this.pollMs);
    }
  }

  /** One JSON-RPC message of the MCP stdio protocol; `undefined` for a notification. */
  async handle(msg: unknown): Promise<Json | undefined> {
    if (!isObj(msg) || typeof msg.method !== 'string') return undefined;
    const id = msg.id;
    const reply = (result: unknown): Json => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string): Json => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined || id === null) return undefined; // notifications/initialized and friends
    switch (msg.method) {
      case 'initialize': {
        const v =
          isObj(msg.params) && typeof msg.params.protocolVersion === 'string'
            ? msg.params.protocolVersion
            : '2024-11-05';
        return reply({
          protocolVersion: v,
          capabilities: { tools: {} },
          serverInfo: { name: 'aom_permission', version: '1' },
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: [
            {
              name: RELAY_TOOL,
              description: 'Ask the organization desk whether a tool call may run (permission prompt relay).',
              inputSchema: {
                type: 'object',
                properties: {
                  tool_name: { type: 'string' },
                  input: { type: 'object' },
                  tool_use_id: { type: 'string' },
                },
                required: ['tool_name', 'input'],
              },
            },
          ],
        });
      case 'tools/call': {
        const p = isObj(msg.params) ? msg.params : {};
        if (p.name !== RELAY_TOOL) return fail(-32602, `unknown tool ${String(p.name)}`);
        const d = await this.decide(isObj(p.arguments) ? p.arguments : {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(d) }] });
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }

  /** Serves newline-delimited JSON-RPC on the streams until stdin ends. */
  async serve(input: AsyncIterable<string | Buffer>, write: (line: string) => void): Promise<void> {
    let buf = '';
    const pending: Promise<void>[] = [];
    const dispatch = (line: string) => {
      if (!line.trim()) return;
      pending.push(
        (async () => {
          try {
            const out = await this.handle(JSON.parse(line));
            if (out) write(`${JSON.stringify(out)}\n`);
          } catch {
            write(
              `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
            );
          }
        })(),
      );
    };
    for await (const chunk of input) {
      buf += chunk.toString();
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        dispatch(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    }
    dispatch(buf);
    await Promise.all(pending);
  }
}
