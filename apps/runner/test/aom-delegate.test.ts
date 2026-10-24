import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function cli(reply: { ok: boolean; result?: unknown; error?: string }) {
  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async () => ({ accepted: true, message: 'ok' }) as never,
    rpc: async (r) => {
      rpcs.push({ method: r.method, params: r.params });
      return reply;
    },
  });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: AomContext = {
    env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    fetch,
    readFile: () => '',
  };
  return { run: (...a: string[]) => runAom(a, ctx), rpcs, out, err };
}

describe('aom delegate', () => {
  it('sends the target and the task, and prints the reply', async () => {
    const t = await cli({ ok: true, result: { text: '--- Reply of delegate "security" ---\nlooks fine\n' } });
    expect(await t.run('delegate', 'security', 'Review the plan.')).toBe(0);
    expect(t.rpcs).toEqual([
      { method: 'delegate.run', params: { target: 'security', task: 'Review the plan.' } },
    ]);
    expect(t.out.join('')).toContain('looks fine');
  });

  it('takes an agent target and joins a task that arrived as several words', async () => {
    const t = await cli({ ok: true, result: { text: 'ok' } });
    await t.run('delegate', 'agent:rex', 'How', 'much?');
    expect(t.rpcs[0]?.params).toEqual({ target: 'agent:rex', task: 'How much?' });
  });

  it('does not take a model: a target runs on the one configured for it', async () => {
    const t = await cli({ ok: true, result: { text: 'ok' } });
    expect(await t.run('delegate', 'security', 'Review the plan.', '--model', 'haiku')).not.toBe(0);
    expect(t.rpcs).toEqual([]);
    expect(t.err.join('')).toContain('`--model` is not accepted');
  });

  it('needs a target and a task', async () => {
    const t = await cli({ ok: true, result: {} });
    expect(await t.run('delegate', 'security')).not.toBe(0);
    expect(t.rpcs).toEqual([]);
    expect(t.err.join('')).toContain('usage: aom delegate');
  });

  it('shows a refusal and fails', async () => {
    const t = await cli({ ok: false, error: 'a delegate cannot delegate: you are already a delegate' });
    expect(await t.run('delegate', 'security', 'x')).not.toBe(0);
    expect(t.err.join('')).toContain('cannot delegate');
  });
});
