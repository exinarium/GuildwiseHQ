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

describe('aom git (backlog #61: agents never push)', () => {
  it('refuses the push subcommand before any request reaches the runner', async () => {
    const t = await cli(() => ({ ok: true, result: { message: 'Pushed.' } }));
    expect(await t.run('git', 'push')).toBe(1);
    expect(await t.run('git', 'push', 'aom/toy-1-x')).toBe(1);
    expect(t.err.join('')).toMatch(/agents never push/);
    expect(t.rpcs).toEqual([]);
  });

  it('still sends fetch, merge-main and verify-merge to the runner', async () => {
    const t = await cli(() => ({ ok: true, result: { message: 'ok' } }));
    expect(await t.run('git', 'fetch')).toBe(0);
    expect(await t.run('git', 'merge-main')).toBe(0);
    expect(await t.run('git', 'verify-merge')).toBe(0);
    expect(t.rpcs.map((r) => r.method)).toEqual(['git.fetch', 'git.merge_main', 'git.verify_merge']);
  });
});
