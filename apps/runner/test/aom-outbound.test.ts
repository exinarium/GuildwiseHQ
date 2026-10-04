import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();
const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function cli(
  files: Record<string, string> = {},
  reply: () => { ok: boolean; result?: unknown; error?: string } = () => ({
    ok: true,
    result: { message: 'Drafted.' },
  }),
) {
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
    readFile: (p) => {
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT ${p}`);
      return f;
    },
  };
  return { run: (...a: string[]) => runAom(a, ctx), rpcs, out, err };
}

describe('aom outbound draft', () => {
  it('sends the kind and the text to the server and prints its answer', async () => {
    const t = await cli();
    expect(await t.run('outbound', 'draft', '--kind', 'comment', '--body', 'Shipped.')).toBe(0);
    expect(t.rpcs).toEqual([{ method: 'outbound.draft', params: { kind: 'comment', body: 'Shipped.' } }]);
    expect(t.out.join('')).toContain('Drafted.');
  });

  it('defaults to a resolution and reads the text from a file', async () => {
    const t = await cli({ 'u.md': 'From a file.' });
    expect(await t.run('outbound', 'draft', '--body-file', 'u.md')).toBe(0);
    expect(t.rpcs[0]?.params).toEqual({ kind: 'resolution', body: 'From a file.' });
  });

  it('shows why a draft was refused so the BA can rewrite it', async () => {
    const t = await cli({}, () => ({
      ok: false,
      error: 'The draft mentions internal details (agent name "Bea").',
    }));
    expect(await t.run('outbound', 'draft', '--body', 'Bea did it')).toBe(1);
    expect(t.err.join('')).toMatch(/internal details/);
  });

  it('needs a body and a valid kind', async () => {
    const t = await cli();
    expect(await t.run('outbound', 'draft')).toBe(1);
    expect(await t.run('outbound', 'draft', '--kind', 'poem', '--body', 'x')).toBe(1);
    expect(await t.run('outbound')).toBe(1);
    expect(t.rpcs).toEqual([]);
  });
});
