import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();
const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function cli(rpcResult: (m: string, p: Record<string, unknown>) => unknown) {
  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async () => ({ accepted: true, message: 'Recorded.' }) as never,
    rpc: async (r) => {
      rpcs.push({ method: r.method, params: r.params });
      return { ok: true, result: rpcResult(r.method, r.params) };
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

describe('aom source attachments / attachment', () => {
  it('lists a ticket and downloads one file or all of them', async () => {
    const t = await cli((m) => `reply to ${m}`);
    expect(await t.run('source', 'attachments', 'DCPL-4276')).toBe(0);
    expect(await t.run('source', 'attachment', 'DCPL-4276', 'SlideOutHistory.svg')).toBe(0);
    expect(await t.run('source', 'attachment', 'DCPL-4276', '--all')).toBe(0);
    expect(t.rpcs).toEqual([
      { method: 'source.attachments', params: { key: 'DCPL-4276' } },
      { method: 'source.attachment', params: { key: 'DCPL-4276', name: 'SlideOutHistory.svg', all: false } },
      { method: 'source.attachment', params: { key: 'DCPL-4276', all: true } },
    ]);
    expect(t.out.join('')).toContain('reply to source.attachments');
  });

  it('needs a key and keeps `source read` working', async () => {
    const t = await cli(() => 'issue text');
    expect(await t.run('source', 'attachments')).toBe(1);
    expect(await t.run('source', 'attachment')).toBe(1);
    expect(t.err.join('')).toMatch(/usage: aom source attachment/);
    expect(await t.run('source', 'read', '--ref', 'acme/toy#1')).toBe(0);
    expect(await t.run('source')).toBe(1);
  });
});

describe('aom card attach / attachments', () => {
  it('sends the absolute path and the card to the runner', async () => {
    const t = await cli(() => 'Attached a.png (1 KB) to TOY-1.');
    expect(await t.run('card', 'attach', 'shots/a.png', '--card', 'TOY-1')).toBe(0);
    expect(await t.run('card', 'attach', '/abs/b.svg')).toBe(0);
    expect(t.rpcs).toEqual([
      { method: 'card.attach', params: { path: resolve('shots/a.png'), ref: 'TOY-1' } },
      { method: 'card.attach', params: { path: '/abs/b.svg' } },
    ]);
    expect(t.out.join('')).toContain('Attached a.png');
    expect(await t.run('card', 'attach')).toBe(1);
    expect(t.err.join('')).toMatch(/usage: aom card attach/);
  });

  it('lists and copies the attachments of a card', async () => {
    const t = await cli(
      () => '1 file(s) copied (read-only):\n- /tmp/aom-x/card-attachments/a.svg (a.svg, 2.0 KB)',
    );
    expect(await t.run('card', 'attachments')).toBe(0);
    expect(await t.run('card', 'attachments', 'TOY-2')).toBe(0);
    expect(t.rpcs).toEqual([
      { method: 'card.attachments', params: {} },
      { method: 'card.attachments', params: { ref: 'TOY-2' } },
    ]);
    expect(t.out.join('')).toContain('/tmp/aom-x/card-attachments/a.svg');
  });
});
