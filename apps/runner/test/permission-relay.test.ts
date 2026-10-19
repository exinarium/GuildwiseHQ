import type { IpcRpcResponse } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { PermissionRelay } from '../src/ceo/permission-relay.ts';

type Call = Record<string, unknown>;

function relay(
  mode: 'owner' | 'order',
  answers: Array<'pending' | 'once' | 'turn' | 'deny' | 'timeout'>,
  over: { timeoutMs?: number } = {},
) {
  const calls: Call[] = [];
  let t = 0;
  const rpc = async (p: Call): Promise<IpcRpcResponse> => {
    calls.push(p);
    if (p.sub === 'ask') return { ok: true, result: { askId: 'ask-1' } };
    return { ok: true, result: { status: answers.shift() ?? 'pending' } };
  };
  const r = new PermissionRelay({
    rpc,
    mode,
    pollMs: 2000,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    ...over,
  });
  return { r, calls };
}

const bash = {
  tool_name: 'Bash',
  input: { command: 'curl -H "Authorization: Bearer abcdefghijkl" x' },
  tool_use_id: 'u1',
};

describe('permission relay', () => {
  it('asks with the redacted input, polls, and allows once with the original input', async () => {
    const { r, calls } = relay('owner', ['pending', 'once']);
    const d = await r.decide(bash);
    expect(d).toEqual({ behavior: 'allow', updatedInput: bash.input });
    expect(calls[0]).toMatchObject({ op: 'permission', sub: 'ask', tool: 'Bash' });
    expect(String(calls[0]?.input)).not.toContain('abcdefghijkl');
    expect(calls.filter((c) => c.sub === 'poll')).toHaveLength(2);
  });

  it('"for this turn" is remembered: the next ask of that tool is not raised again', async () => {
    const { r, calls } = relay('owner', ['turn']);
    expect((await r.decide(bash)).behavior).toBe('allow');
    const n = calls.length;
    expect((await r.decide(bash)).behavior).toBe('allow');
    expect(calls.length).toBe(n);
    // another tool still asks
    await r.decide({ tool_name: 'Write', input: {} }).catch(() => {});
    expect(calls.length).toBeGreaterThan(n);
  });

  it('deny and a server timeout deny', async () => {
    expect((await relay('owner', ['deny']).r.decide(bash)).behavior).toBe('deny');
    const t = await relay('owner', ['timeout']).r.decide(bash);
    expect(t.behavior).toBe('deny');
  });

  it('gives up after 10 minutes of no answer: a deny', async () => {
    const { r, calls } = relay('owner', []);
    const d = await r.decide(bash);
    expect(d.behavior).toBe('deny');
    expect(calls.filter((c) => c.sub === 'poll').length).toBeGreaterThanOrEqual(300);
  });

  it('an order turn raises the question but denies at once and says the step is waiting', async () => {
    const { r, calls } = relay('order', ['once']);
    const d = await r.decide(bash);
    expect(d.behavior).toBe('deny');
    expect((d as { message: string }).message).toContain('aom ceo order done');
    expect(calls.map((c) => c.sub)).toEqual(['ask']);
  });

  it('denies when the question could not be raised', async () => {
    const r = new PermissionRelay({
      mode: 'owner',
      rpc: async () => ({ ok: false, error: 'server unreachable' }),
    });
    const d = await r.decide(bash);
    expect(d.behavior).toBe('deny');
  });

  it('speaks MCP over stdio: initialize, tools/list, tools/call', async () => {
    const { r } = relay('owner', ['once']);
    const init = await r.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(((init as { result: unknown }).result as { protocolVersion: string }).protocolVersion).toBe(
      '2025-03-26',
    );
    expect(await r.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    const list = await r.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(((list as { result: unknown }).result as { tools: Array<{ name: string }> }).tools[0]?.name).toBe(
      'ask',
    );
    const call = await r.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ask', arguments: bash },
    });
    const text =
      ((call as { result: unknown }).result as { content: Array<{ text: string }> }).content[0]?.text ?? '';
    expect(JSON.parse(text)).toMatchObject({ behavior: 'allow' });
    expect(
      ((await r.handle({ jsonrpc: '2.0', id: 4, method: 'nope' })) as { error: unknown }).error,
    ).toBeTruthy();
  });

  it('serves newline-delimited requests from a stream', async () => {
    const { r } = relay('owner', ['once']);
    const out: string[] = [];
    async function* input() {
      yield `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`;
    }
    await r.serve(input(), (l) => out.push(l));
    expect(out).toHaveLength(2);
  });
});
