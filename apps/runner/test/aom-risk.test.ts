import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();
const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function cli(reply: () => { ok: boolean; result?: unknown; error?: string }) {
  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async () => ({ accepted: true, message: '' }) as never,
    rpc: async (r) => {
      rpcs.push({ method: r.method, params: r.params });
      return reply() as never;
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

describe('aom risk', () => {
  it('sends the tier and the reason to the server and prints its answer', async () => {
    const t = await cli(() => ({ ok: true, result: { message: 'Risk tier of TOY-1 is now large.' } }));
    expect(await t.run('risk', 'large', '--reason', 'Touches the billing rules')).toBe(0);
    expect(t.rpcs).toEqual([
      { method: 'card.risk', params: { tier: 'large', reason: 'Touches the billing rules' } },
    ]);
    expect(t.out.join('')).toContain('now large');
  });

  it('needs a tier of small or large and a reason', async () => {
    const t = await cli(() => ({ ok: true }));
    expect(await t.run('risk')).toBe(1);
    expect(await t.run('risk', 'huge', '--reason', 'x')).toBe(1);
    expect(await t.run('risk', 'small')).toBe(1);
    expect(t.rpcs).toEqual([]);
  });

  it('shows why the server refused', async () => {
    const t = await cli(() => ({ ok: false, error: 'only the business analyst overrides the risk tier' }));
    expect(await t.run('risk', 'small', '--reason', 'mechanical')).toBe(1);
    expect(t.err.join('')).toMatch(/business analyst/);
  });
});
