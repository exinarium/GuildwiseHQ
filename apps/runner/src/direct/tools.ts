import {
  formatLedgerMatches,
  IPC_RPC_PATH,
  type IpcRpcResponse,
  type LedgerMatch,
  type SessionToolDef,
} from '@aom/shared';
import { type ToolSet, tool } from 'ai';
import { redact } from '../secrets/redact.ts';

/** A tool call the server (or the runner's IPC handler) refused: the model is told why and the turn goes on. */
export class ToolRefused extends Error {
  readonly refused = true;
}

export interface IpcTarget {
  url: string;
  token: string;
  fetch?: typeof fetch;
}

/**
 * One rpc call over the runner's IPC, exactly what `aom <verb>` sends: `POST /v1/rpc` with the turn's token. The runner's
 * handler for a session turn (`ChatManager.handlerFor`) lets only `skill.*`, `ledger.search`, `session.*` and `board.*`
 * through, and the server then checks the verb against the turn's purpose. So the permission table is the one the Claude Code
 * path uses; this code decides nothing about what is allowed.
 */
export async function callRpc(
  ipc: IpcTarget,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await (ipc.fetch ?? fetch)(`${ipc.url}${IPC_RPC_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ipc.token}` },
      body: JSON.stringify({ method, params }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw new Error(`cannot reach the runner: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) throw new ToolRefused('this turn is over (its token is no longer valid)');
  let body: (IpcRpcResponse & { error?: string }) | undefined;
  try {
    body = (await res.json()) as IpcRpcResponse & { error?: string };
  } catch {
    // empty body
  }
  if (res.status !== 200 || !body?.ok)
    throw new ToolRefused(body?.error ?? `${method} failed (HTTP ${res.status})`);
  return body.result;
}

/** The text a tool returns to the model: what `aom` would have printed. */
export function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  const r = result as { text?: unknown; message?: unknown; entries?: unknown } | null;
  if (r && Array.isArray(r.entries)) return formatLedgerMatches(r.entries as LedgerMatch[]);
  if (r && typeof r.text === 'string') return r.text.replace(/\n*$/, '');
  if (r && typeof r.message === 'string') return r.message;
  return result === undefined || result === null ? 'Done.' : JSON.stringify(result, null, 2);
}

/** The most a tool result may add to the model's context (a playbook or a PRD can be far longer than a turn needs). */
export const TOOL_RESULT_MAX_CHARS = 20_000;

/** Cuts a tool result to `max` characters and says so, so the model knows the text is incomplete. */
export function capToolResult(text: string, max = TOOL_RESULT_MAX_CHARS): string {
  return text.length > max
    ? `${text.slice(0, max)}\n\n[cut: ${text.length - max} more characters were not shown]`
    : text;
}

/** The AI SDK tool set for a turn: one tool per allowed verb, each a typed call of the same rpc `aom` would make. */
export function buildToolSet(defs: readonly SessionToolDef[], ipc: IpcTarget, signal?: AbortSignal): ToolSet {
  const out: ToolSet = {};
  for (const def of defs) {
    out[def.name] = tool({
      description: def.description,
      inputSchema: def.input as never,
      execute: async (input: unknown) => {
        const params = { ...((input ?? {}) as Record<string, unknown>), ...(def.fixed ?? {}) };
        try {
          return capToolResult(resultText(await callRpc(ipc, def.rpc, params, signal)));
        } catch (err) {
          // Whatever the server said, with any key-shaped text removed: the model sees it, a log may keep it.
          const e = err instanceof Error ? err : new Error(String(err));
          if (e instanceof ToolRefused) throw new ToolRefused(redact(e.message));
          throw new Error(redact(e.message));
        }
      },
    }) as ToolSet[string];
  }
  return out;
}

/** A short, one-line summary of a tool call for the activity strip (never the whole input: drafts can be long). */
export function summarizeCall(name: string, input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input ?? {});
  } catch {
    text = '';
  }
  return `${name} ${text}`.slice(0, 300);
}
