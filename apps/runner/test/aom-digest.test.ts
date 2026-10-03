import type { ShiftReport } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function cli(files: Record<string, string>) {
  const reports: ShiftReport[] = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async (r) => {
      reports.push(r.report);
      return { accepted: true, message: 'Recorded. Finish now.' };
    },
    rpc: async () => ({ ok: true }),
  });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: AomContext = {
    env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    fetch,
    readFile: (p) => files[p] ?? '',
  };
  return { run: (...a: string[]) => runAom(a, ctx), reports, out, err };
}

const item = {
  kind: 'article',
  url: 'https://a.test/1',
  title: 'T',
  source: 'S',
  publishedAt: '2026-10-02',
  summary: 'x',
};

describe('aom digest and aom handoff --data-file', () => {
  it('posts the digest file as the digest outcome (object or bare array)', async () => {
    const t = await cli({
      'd.json': JSON.stringify({ items: [item] }),
      'a.json': JSON.stringify([item, item]),
    });
    expect(await t.run('digest', '--file', 'd.json', '--note', 'picked one')).toBe(0);
    expect(await t.run('digest', '--file', 'a.json')).toBe(0);
    expect(t.reports[0]).toEqual({
      kind: 'outcome',
      outcomeId: 'digest',
      note: 'picked one',
      data: { items: [item] },
    });
    expect(t.reports[1]).toMatchObject({
      outcomeId: 'digest',
      note: 'Digest of 2 item(s)',
      data: { items: [item, item] },
    });
  });

  it('--none posts an empty digest ("nothing qualified")', async () => {
    const t = await cli({});
    expect(await t.run('digest', '--none')).toBe(0);
    expect(t.reports[0]).toMatchObject({
      outcomeId: 'digest',
      note: 'Nothing qualified',
      data: { items: [] },
    });
  });

  it('needs --file or --none', async () => {
    const t = await cli({});
    expect(await t.run('digest')).toBe(1);
    expect(t.err.join('')).toMatch(/usage: aom digest/);
    expect(t.reports).toEqual([]);
  });

  it('the scout hands off its candidates with --data-file', async () => {
    const t = await cli({ 'c.json': JSON.stringify({ items: [item] }) });
    expect(await t.run('handoff', '--note', 'searched', '--data-file', 'c.json')).toBe(0);
    expect(t.reports[0]).toEqual({
      kind: 'outcome',
      outcomeId: 'handoff',
      note: 'searched',
      data: { items: [item] },
    });
    expect(await t.run('handoff', '--note', 'plain')).toBe(0);
    expect(t.reports[1]).toMatchObject({ data: {} });
  });
});

describe('aom publish', () => {
  const cites = [{ url: 'https://a.test/1', title: 'A' }];
  it('sends the note and its citations as the published outcome', async () => {
    const t = await cli({ 'n.md': '# Title\n\nBody', 'c.json': JSON.stringify(cites) });
    expect(await t.run('publish', '--file', 'n.md', '--title', 'Title', '--citations-file', 'c.json')).toBe(
      0,
    );
    expect(t.reports[0]).toEqual({
      kind: 'outcome',
      outcomeId: 'published',
      note: 'Published: Title',
      data: { content: '# Title\n\nBody', citations: cites, title: 'Title' },
    });
  });

  it('accepts {citations: [...]}, an explicit path and note; citations are optional here (the runner refuses without)', async () => {
    const t = await cli({ 'n.md': 'x', 'c.json': JSON.stringify({ citations: cites }) });
    expect(
      await t.run(
        'publish',
        '--file',
        'n.md',
        '--citations-file',
        'c.json',
        '--path',
        'projects/x/n.md',
        '--note',
        'ok',
      ),
    ).toBe(0);
    expect(t.reports[0]).toMatchObject({ note: 'ok', data: { citations: cites, path: 'projects/x/n.md' } });
    expect(await t.run('publish', '--file', 'n.md')).toBe(0);
    expect(t.reports[1]).toMatchObject({ data: { content: 'x', citations: [] } });
    expect(await t.run('publish')).toBe(1);
    expect(t.err.join('')).toMatch(/usage: aom publish/);
  });
});
