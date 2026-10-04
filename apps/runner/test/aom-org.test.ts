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
    result: { message: 'Saved.' },
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

describe('aom org', () => {
  it('drafts a role and a workflow from JSON files', async () => {
    const t = await cli({ 'r.json': '{"key":"triager"}', 'w.json': '{"key":"support"}' });
    expect(await t.run('org', 'role', 'draft', '--file', 'r.json')).toBe(0);
    expect(await t.run('org', 'workflow', 'draft', '--file', 'w.json')).toBe(0);
    expect(t.rpcs).toEqual([
      { method: 'org.role.draft', params: { definition: { key: 'triager' } } },
      { method: 'org.workflow.draft', params: { definition: { key: 'support' } } },
    ]);
    expect(t.out.join('')).toContain('Saved.');
  });

  it('validates and submits by key, optionally naming the kind', async () => {
    const t = await cli();
    expect(await t.run('org', 'validate', 'support', '--workflow')).toBe(0);
    expect(await t.run('org', 'submit', 'triager')).toBe(0);
    expect(t.rpcs).toEqual([
      { method: 'org.validate', params: { key: 'support', kind: 'workflow' } },
      { method: 'org.submit', params: { key: 'triager' } },
    ]);
  });

  it('lists the catalogue and creates departments', async () => {
    const t = await cli();
    expect(await t.run('org', 'catalogue')).toBe(0);
    expect(await t.run('org', 'department', '--name', 'support')).toBe(0);
    expect(t.rpcs.map((r) => r.method)).toEqual(['org.catalogue', 'org.department']);
  });

  it('shows the server issues when a draft is refused, and usage on bad input', async () => {
    const t = await cli({ 'w.json': '{}' }, () => ({
      ok: false,
      error: 'cannot submit: stage x is unreachable',
    }));
    expect(await t.run('org', 'submit', 'support')).toBe(1);
    expect(t.err.join('')).toContain('unreachable');
    expect(await t.run('org')).toBe(1);
    expect(t.err.join('')).toContain('usage: aom org');
    expect(await t.run('org', 'role', 'draft')).toBe(1);
    expect(await t.run('org', 'workflow', 'draft', '--file', 'missing.json')).toBe(1);
  });
});
