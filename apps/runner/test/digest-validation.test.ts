import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkFeedItemsFetched, FetchedUrls } from '../src/feeds/validation.ts';
import { feedItem, makeFeedShiftStart } from './feed-fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const outcome = (outcomeId: string, data: Record<string, unknown>) => ({
  report: { kind: 'outcome', outcomeId, note: 'n', data },
});

async function runFeedShift(msg: Record<string, unknown>) {
  const shiftId = msg.shiftId as string;
  h!.server.send('shift.start', msg);
  return h!.server.waitFor('shift.ended', (m) => m.shiftId === shiftId, 60_000);
}

const reports = (shiftId: string) => h!.server.of('shift.report').filter((r) => r.shiftId === shiftId);

describe('FetchedUrls / checkFeedItemsFetched', () => {
  it('records only WebFetch pages, compared by normalized URL', () => {
    const f = new FetchedUrls();
    f.record('WebSearch', 'https://a.test/x');
    f.record('Bash', 'curl https://b.test/y');
    f.record('WebFetch', '{"url":"https://www.C.test/post/?utm_source=x","prompt":"summarise"}');
    f.record('WebFetch', 'https://d.test/video/1');
    expect(f.size).toBe(2);
    expect(f.has('https://c.test/post')).toBe(true);
    expect(f.has('http://d.test/video/1/')).toBe(true);
    expect(f.has('https://a.test/x')).toBe(false);
    expect(f.has('https://b.test/y')).toBe(false);
  });

  it('flags items that were not opened; a curator may also report what the scout opened', () => {
    const f = new FetchedUrls();
    f.record('WebFetch', 'https://news.example.test/story-1');
    const data = { items: [feedItem(1), feedItem(2)] };
    expect(checkFeedItemsFetched({ dataKind: 'candidates', data, fetched: f })).toMatch(/story-2/);
    expect(
      checkFeedItemsFetched({ dataKind: 'candidates', data: { items: [feedItem(1)] }, fetched: f }),
    ).toBeNull();
    expect(
      checkFeedItemsFetched({ dataKind: 'digest', data, fetched: f, vouched: [feedItem(2).url] }),
    ).toBeNull();
    // a scout's own report is not excused by "vouched"
    expect(
      checkFeedItemsFetched({ dataKind: 'candidates', data, fetched: f, vouched: [feedItem(2).url] }),
    ).toMatch(/story-2/);
    expect(checkFeedItemsFetched({ dataKind: 'candidates', data: { items: [] }, fetched: f })).toBeNull();
    expect(checkFeedItemsFetched({ dataKind: 'review', data, fetched: f })).toBeNull();
  });
});

describe('the runner rejects feed items that were never opened (no fabrication)', () => {
  it('a scout report with an unopened page is rejected in-shift and accepted without it', async () => {
    const seen: Record<string, any> = {};
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      ctl.emit({ kind: 'tool', name: 'WebFetch', summary: feedItem(1).url });
      await new Promise((r) => setTimeout(r, 100));
      seen.bad = await ctl.post('/v1/report', outcome('handoff', { items: [feedItem(1), feedItem(2)] }));
      seen.good = await ctl.post('/v1/report', outcome('handoff', { items: [feedItem(1)] }));
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const msg = makeFeedShiftStart({ stage: 'scan' });
    const ended = await runFeedShift(msg);
    expect(seen.bad.status).toBe(422);
    expect(seen.bad.json.error).toMatch(/not pages you opened.*story-2/);
    expect(seen.good.status).toBe(200);
    expect(ended.outcome).toBe('reported');
    const sent = reports(msg.shiftId as string);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.report).toMatchObject({
      outcomeId: 'handoff',
      data: { items: [{ url: feedItem(1).url }] },
    });
  });

  it('a scout must look up the transcript of every video or podcast candidate; the runner attaches the reference', async () => {
    const seen: Record<string, any> = {};
    const video = feedItem(2, { kind: 'video', url: 'https://video.example.test/2' });
    const podcast = feedItem(3, { kind: 'podcast', url: 'https://pod.example.test/3' });
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      for (const i of [feedItem(1), video, podcast])
        ctl.emit({ kind: 'tool', name: 'WebFetch', summary: i.url });
      await new Promise((r) => setTimeout(r, 100));
      seen.skipped = await ctl.post('/v1/report', outcome('handoff', { items: [feedItem(1), video] }));
      seen.rpc = await ctl.post('/v1/rpc', { method: 'transcript.fetch', params: { url: video.url } });
      seen.none = await ctl.post('/v1/rpc', {
        method: 'transcript.fetch',
        params: { url: 'https://pod.example.test/3?no-transcript=1' },
      });
      seen.ok = await ctl.post('/v1/report', outcome('handoff', { items: [feedItem(1), video, podcast] }));
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const msg = makeFeedShiftStart({ stage: 'scan' });
    await runFeedShift(msg);
    expect(seen.skipped.status).toBe(422);
    expect(seen.skipped.json.error).toMatch(/no transcript lookup.*video\.example\.test\/2/);
    expect(seen.rpc.json.result.status).toBe('ok');
    expect(seen.rpc.json.result.message).toContain('Status: ok');
    expect(seen.none.json.result.message).toContain('no transcript available');
    // a podcast URL with a query string is a different URL than the one looked up: still unresolved
    expect(seen.ok.status).toBe(422);
  });

  it('scout report with transcripts looked up carries the reference on the items, and a forged one is replaced', async () => {
    const seen: Record<string, any> = {};
    const video = feedItem(2, { kind: 'video', url: 'https://video.example.test/2' });
    const podcast = feedItem(3, { kind: 'podcast', url: 'https://pod.example.test/no-transcript' });
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      for (const i of [video, podcast]) ctl.emit({ kind: 'tool', name: 'WebFetch', summary: i.url });
      await new Promise((r) => setTimeout(r, 100));
      await ctl.post('/v1/rpc', { method: 'transcript.fetch', params: { url: video.url } });
      await ctl.post('/v1/rpc', { method: 'transcript.fetch', params: { url: podcast.url } });
      seen.ok = await ctl.post(
        '/v1/report',
        outcome('handoff', {
          items: [{ ...video, transcript: { status: 'ok', path: 'forged.md', chars: 1 } }, podcast],
        }),
      );
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const msg = makeFeedShiftStart({ stage: 'scan' });
    await runFeedShift(msg);
    expect(seen.ok.status).toBe(200);
    const items = (reports(msg.shiftId as string)[0] as any).report.data.items;
    expect(items[0].transcript).toMatchObject({ status: 'ok', autoGenerated: true });
    expect(items[0].transcript.path).toBeUndefined(); // no vault in this shift
    expect(items[0].transcript.chars).toBeGreaterThan(20);
    expect(items[1].transcript).toEqual({ status: 'none' });
  });

  it("a curator may post the scout's candidates but nothing else", async () => {
    const seen: Record<string, any> = {};
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      seen.stray = await ctl.post('/v1/report', outcome('digest', { items: [feedItem(1), feedItem(9)] }));
      seen.ok = await ctl.post('/v1/report', outcome('digest', { items: [feedItem(1)] }));
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const msg = makeFeedShiftStart({
      stage: 'curate',
      feed: { candidates: [feedItem(1), feedItem(2)], seenUrls: [], tasteSeed: [] },
    });
    await runFeedShift(msg);
    expect(seen.stray.status).toBe(422);
    expect(seen.stray.json.error).toMatch(/story-9/);
    expect(seen.ok.status).toBe(200);
  });

  it('an empty candidate list or digest ("nothing qualified") is valid', async () => {
    const seen: Record<string, any> = {};
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      seen.r = await ctl.post('/v1/report', outcome('digest', { items: [] }));
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    await runFeedShift(makeFeedShiftStart({ stage: 'curate' }));
    expect(seen.r.status).toBe(200);
  });
});

describe('mock adapter: scripted feed runs through the real aom CLI', () => {
  it('the scout opens its scripted pages and hands them off as candidates', async () => {
    h = await startHarness();
    const items = [feedItem(1), feedItem(2, { kind: 'video', url: 'https://video.example.test/2' })];
    const msg = makeFeedShiftStart({ stage: 'scan', fields: { mockFeed: { items } } });
    const ended = await runFeedShift(msg);
    expect(ended.outcome).toBe('reported');
    // the mock scout looked up the video's transcript through `aom transcript`; the runner attached the reference
    const sent = (reports(msg.shiftId as string)[0] as any).report;
    expect(sent.outcomeId).toBe('handoff');
    expect(sent.data.items[0]).toEqual(items[0]);
    expect(sent.data.items[1]).toMatchObject({
      ...items[1],
      transcript: { status: 'ok', autoGenerated: true },
    });
  }, 120_000);

  it('action fabricate: the runner rejects the extra page and the scout retries without it', async () => {
    h = await startHarness();
    const msg = makeFeedShiftStart({ stage: 'scan', fields: { mock: { scan: ['fabricate'] } } });
    const ended = await runFeedShift(msg);
    expect(ended.outcome).toBe('reported');
    const sent = reports(msg.shiftId as string);
    expect(sent).toHaveLength(1);
    const urls = ((sent[0] as any).report.data.items as Array<{ url: string }>).map((i) => i.url);
    expect(urls).toEqual([
      'https://example.test/1',
      'https://example.test/2',
      'https://video.example.test/watch/3',
    ]);
  }, 120_000);

  it('the curator reads taste.md at shift start, skips what it says to skip and respects the maximum per kind', async () => {
    h = await startHarness();
    const vaultId = 'vault-1';
    const root = join(h.dataDir, 'vaults', vaultId);
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'projects', 'news'), { recursive: true });
    writeFileSync(
      join(root, 'projects', 'news', 'taste.md'),
      '# Taste\n\n- Skip articles like "Headline 2" from News Example (rated irrelevant). Example: https://news.example.test/story-2\n',
    );
    const candidates = [
      feedItem(1),
      feedItem(2),
      feedItem(3),
      feedItem(4, { kind: 'video', url: 'https://video.example.test/4' }),
    ];
    const msg = makeFeedShiftStart({
      stage: 'curate',
      fields: {
        maxItems: 2,
        mockFeed: { items: [], proposeRule: 'Prefer videos with chronograph data' },
      },
      feed: { candidates, seenUrls: [], tasteSeed: [] },
      vault: { vaultId, kind: 'personal', folder: 'projects/news' },
    });
    const ended = await runFeedShift(msg);
    expect(ended.outcome).toBe('reported');
    const rep = reports(msg.shiftId as string)[0]?.report as any;
    expect(rep.outcomeId).toBe('digest');
    // the best 2 overall, whatever the kind: Headline 2 is skipped by taste, so items 1 and 3
    expect(rep.data.items.map((i: any) => i.url)).toEqual([candidates[0]?.url, candidates[2]?.url]);
    expect(rep.data.tasteRuleProposal).toEqual({
      rule: 'Prefer videos with chronograph data',
      evidenceUrls: [candidates[0]?.url],
    });
    // the curator saw taste.md in the card it read at shift start
    const log = h.server
      .of('shift.progress')
      .flatMap((p) => p.items)
      .map((i) => i.text);
    expect(log).toContain('mock taste: 1 rule line(s)');
    expect(log.some((t) => t.startsWith('mock taste rule: - Skip articles like "Headline 2"'))).toBe(true);
  }, 120_000);

  it('a curator with nothing left posts an empty digest', async () => {
    h = await startHarness();
    const msg = makeFeedShiftStart({
      stage: 'curate',
      feed: { candidates: [], seenUrls: [], tasteSeed: [] },
    });
    const ended = await runFeedShift(msg);
    expect(ended.outcome).toBe('reported');
    expect(reports(msg.shiftId as string)[0]?.report).toMatchObject({
      outcomeId: 'digest',
      data: { items: [] },
    });
  }, 120_000);
});
