import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function setup() {
  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async () => ({ accepted: true, message: 'ok' }) as never,
    rpc: async (r) => {
      rpcs.push({ method: r.method, params: r.params });
      return r.method.startsWith('graph.')
        ? { ok: true, result: { text: `answer to ${r.method}` } }
        : { ok: false, error: 'unexpected' };
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
  return { run: (...argv: string[]) => runAom(argv, ctx), rpcs, out, err };
}

describe('aom ceo route', () => {
  it('sends the request, or --drafts; neither is a usage error', async () => {
    const { run, rpcs, out } = await setup();
    // the fake runner here answers any `ceo` call with a refusal; only what is sent matters
    await run('ceo', 'route', 'fix', 'the', 'checkout', 'total').catch(() => undefined);
    await run('ceo', 'route', '--drafts').catch(() => undefined);
    expect(rpcs).toEqual([
      { method: 'ceo', params: { op: 'route', q: 'fix the checkout total' } },
      { method: 'ceo', params: { op: 'route', q: '', drafts: true } },
    ]);
    expect(await run('ceo', 'route')).not.toBe(0);
    expect(rpcs).toHaveLength(2);
    expect(out.join('')).toBe('');
  });
});

describe('aom graph', () => {
  it('query joins the words, takes --budget, and prints the runner answer', async () => {
    const { run, rpcs, out } = await setup();
    expect(await run('graph', 'query', 'invoice', 'total', '--budget', '800')).toBe(0);
    expect(rpcs).toEqual([{ method: 'graph.query', params: { text: 'invoice total', budget: 800 } }]);
    expect(out.join('')).toBe('answer to graph.query\n');
  });

  it('path, explain and impact pass their nodes, and impact its depth', async () => {
    const { run, rpcs } = await setup();
    await run('graph', 'path', 'a.ts:Foo', 'b.ts:Bar');
    await run('graph', 'explain', 'src/x.ts:Thing');
    await run('graph', 'impact', 'src/x.ts', '--depth', '3');
    expect(rpcs).toEqual([
      { method: 'graph.path', params: { a: 'a.ts:Foo', b: 'b.ts:Bar' } },
      { method: 'graph.explain', params: { node: 'src/x.ts:Thing' } },
      { method: 'graph.impact', params: { node: 'src/x.ts', depth: 3 } },
    ]);
  });

  it('a missing argument or a bad number is a usage error, and nothing is asked', async () => {
    const { run, rpcs, err } = await setup();
    for (const argv of [
      ['graph'],
      ['graph', 'query'],
      ['graph', 'path', 'a'],
      ['graph', 'explain'],
      ['graph', 'bogus', 'x'],
    ]) {
      expect(await run(...argv)).not.toBe(0);
    }
    expect(await run('graph', 'query', 'x', '--budget', 'lots')).not.toBe(0);
    expect(rpcs).toEqual([]);
    expect(err.join('')).toMatch(/usage: aom graph/);
  });
});
