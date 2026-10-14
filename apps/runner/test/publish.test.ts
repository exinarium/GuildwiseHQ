import { type PublishRequest, parseNoteFrontMatter } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FetchedUrls } from '../src/feeds/validation.ts';
import { preparePublication } from '../src/research/publish.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';
import { DRAFT, makeResearchShiftStart, researchHandoff } from './research-fixtures.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';
import { IDENTITY, makeVault, originFile, originLog, type VaultFixture } from './vault-fixtures.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const FOLDER = 'projects/shooting';
const AT = new Date('2026-10-03T08:00:00.000Z');
const fetched = (...urls: string[]) => {
  const f = new FetchedUrls();
  for (const u of urls) f.record('WebFetch', u);
  return f;
};
const prep = (request: Partial<PublishRequest>, f = fetched('https://a.test/1', 'https://a.test/2')) =>
  preparePublication({
    request: { content: '# Title\n\nBody.', citations: [], ...request } as PublishRequest,
    folder: FOLDER,
    card: { ref: 'SHOOT-1', subCategory: 'Hunting ballistics' },
    fetched: f,
    at: AT,
  });

describe('preparePublication (the checker guard)', () => {
  it('refuses a note without citations: no citations, no publication', () => {
    const r = prep({});
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/No citations, no publication/);
    expect(prep({ content: '---\ntitle: T\ncitations:\n---\nbody' })).toMatchObject({ ok: false });
  });

  it('refuses a citation the checker did not open in this shift', () => {
    const r = prep({
      citations: [
        { url: 'https://a.test/1', title: 'A' },
        { url: 'https://nope.test/x', title: 'N' },
      ],
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/not pages you opened.*nope\.test/);
  });

  it('accepts citations from the command or the front matter and writes normalized front matter', () => {
    const viaFile = prep({ citations: [{ url: 'https://a.test/1', title: 'First' }] });
    expect(viaFile.ok).toBe(true);
    if (!viaFile.ok) return;
    expect(viaFile.path).toBe('projects/shooting/hunting-ballistics/title.md');
    const fm = parseNoteFrontMatter(viaFile.content);
    expect(fm?.title).toBe('Title');
    expect(fm?.citations).toEqual([
      { url: 'https://a.test/1', title: 'First', accessedAt: AT.toISOString() },
    ]);
    expect(viaFile.content).toContain('card: SHOOT-1');
    expect(viaFile.content).toContain('subCategory: "Hunting ballistics"');
    expect(viaFile.publication).toMatchObject({
      vaultPath: viaFile.path,
      title: 'Title',
      citations: [{ url: 'https://a.test/1' }],
      excerpt: 'Body.',
    });

    const inNote = prep({
      content: '---\ntitle: From front matter\ncitations:\n  - https://a.test/2\n---\n\nBody',
    });
    expect(inNote).toMatchObject({ ok: true, publication: { title: 'From front matter' } });
    // both sources merge by normalized URL
    const merged = prep({
      content: '---\ncitations:\n  - https://a.test/1\n---\n# T\nBody',
      citations: [
        { url: 'https://www.a.test/1/', title: 'dup' },
        { url: 'https://a.test/2', title: 'Second' },
      ],
    });
    expect(merged.ok && merged.publication.citations.map((c) => c.url)).toEqual([
      'https://a.test/1',
      'https://a.test/2',
    ]);
  });

  it('keeps the note inside the project vault folder and a markdown path', () => {
    const c = [{ url: 'https://a.test/1', title: 'A' }];
    expect(prep({ citations: c, path: 'projects/shooting/custom/note.md' })).toMatchObject({
      ok: true,
      path: 'projects/shooting/custom/note.md',
    });
    for (const path of [
      'projects/other/note.md',
      'standing-orders.md',
      'projects/shooting/../x.md',
      '/abs.md',
      'projects/shooting/n.txt',
    ])
      expect(prep({ citations: c, path })).toMatchObject({ ok: false });
    expect(prep({ citations: c, content: 'no title anywhere' })).toMatchObject({ ok: false });
  });

  it('is deterministic for a retried publish (dates come from the shift start)', () => {
    const a = prep({ citations: [{ url: 'https://a.test/1', title: 'A' }] });
    const b = prep({ citations: [{ url: 'https://a.test/1', title: 'A' }] });
    expect(a).toEqual(b);
  });
});

async function startWithVault(adapter?: ScriptedAdapter) {
  const vault = makeVault({ 'projects/shooting/PROJECT.md': '# Shooting\n' });
  h = await startHarness({}, adapter ? { adapters: new Map([['mock', adapter]]) } : {});
  h.server.send('command', {
    commandId: 'cfg',
    command: 'vault.configure',
    payload: {
      vaults: [
        {
          vaultId: 'vault-1',
          kind: 'org',
          name: 'Personal',
          remoteUrl: vault.origin,
          syncIntervalSec: 3600,
        },
      ],
      identity: IDENTITY,
      workstationName: 'Desk',
    },
  });
  expect((await h.server.waitFor('command.result', (m) => m.commandId === 'cfg')).ok).toBe(true);
  return vault;
}

const VAULT = { vaultId: 'vault-1', kind: 'org' as const, folder: FOLDER };
const run = async (msg: Record<string, unknown>) => {
  h!.server.send('shift.start', msg);
  return h!.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 90_000);
};
/** The first report the server received for a shift. */
const reportOf = (shiftId: string): any => (reportsOf(shiftId)[0] as any)?.report;
const reportsOf = (shiftId: string) => h!.server.of('shift.report').filter((r) => r.shiftId === shiftId);

describe('aom publish through the runner (scripted checker)', () => {
  it('rejects an uncited note and an unopened source in-shift, then writes, commits and pushes the verified note', async () => {
    const seen: Record<string, any> = {};
    let vault!: VaultFixture;
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      const publish = (data: Record<string, unknown>) =>
        ctl.post('/v1/report', {
          report: { kind: 'outcome', outcomeId: 'published', note: 'verified', data },
        });
      seen.uncited = await publish({ content: '# Is 6mm ARC enough for deer?\n\nYes.', citations: [] });
      ctl.emit({ kind: 'tool', name: 'WebFetch', summary: 'https://example.test/research/1' });
      await new Promise((r) => setTimeout(r, 100));
      seen.unopened = await publish({
        content: '# Is 6mm ARC enough for deer?\n\nYes.',
        citations: [
          { url: 'https://example.test/research/1', title: 'Hornady ballistics' },
          { url: 'https://example.test/research/9', title: 'Never opened' },
        ],
      });
      seen.ok = await publish({
        content: '# Is 6mm ARC enough for deer?\n\nShort answer: yes, within 300 yards. [1]',
        citations: [{ url: 'https://example.test/research/1', title: 'Hornady ballistics' }],
      });
    });
    vault = await startWithVault(adapter);
    const msg = makeResearchShiftStart({ stage: 'factcheck', handoffs: researchHandoff(), vault: VAULT });
    const ended = await run(msg);

    expect(seen.uncited.status).toBe(422);
    expect(seen.uncited.json.error).toMatch(/No citations, no publication/);
    expect(seen.unopened.status).toBe(422);
    expect(seen.unopened.json.error).toMatch(/research\/9/);
    expect(seen.ok.status).toBe(200);
    expect(ended.outcome).toBe('reported');

    // the server hears the path, title and citations, not the note
    const sent = reportsOf(msg.shiftId as string);
    expect(sent).toHaveLength(1);
    const data = (sent[0] as any).report.data;
    expect(data).toMatchObject({
      vaultPath: 'projects/shooting/hunting-ballistics/is-6mm-arc-enough-for-deer.md',
      title: 'Is 6mm ARC enough for deer?',
      citations: [{ url: 'https://example.test/research/1', title: 'Hornady ballistics' }],
    });
    expect(data.content).toBeUndefined();
    expect(data.excerpt).toContain('Short answer: yes');

    // the note is in the vault origin: committed by the DevOps identity, with the citations in its front matter
    const note = originFile(vault, data.vaultPath);
    expect(parseNoteFrontMatter(note)?.citations.map((c) => c.url)).toEqual([
      'https://example.test/research/1',
    ]);
    expect(note).toContain('Short answer: yes');
    expect(originLog(vault)[0]).toMatch(/^Workstation Owner\|Research: Is 6mm ARC enough for deer\?/);
  }, 120_000);

  it('a checker with no vault cannot publish', async () => {
    const seen: Record<string, any> = {};
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      ctl.emit({ kind: 'tool', name: 'WebFetch', summary: 'https://example.test/research/1' });
      await new Promise((r) => setTimeout(r, 100));
      seen.r = await ctl.post('/v1/report', {
        report: {
          kind: 'outcome',
          outcomeId: 'published',
          note: 'n',
          data: { content: '# T\n\nx', citations: [{ url: 'https://example.test/research/1', title: 'A' }] },
        },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    await run(makeResearchShiftStart({ stage: 'factcheck', vault: null }));
    expect(seen.r.status).toBe(422);
    expect(seen.r.json.error).toMatch(/no knowledge vault/);
  });
});

describe('mock researcher and checker through the real aom CLI', () => {
  it('researcher: opens the claim pages and hands off a draft with numbered references', async () => {
    h = await startHarness();
    const msg = makeResearchShiftStart({ stage: 'research' });
    expect((await run(msg)).outcome).toBe('reported');
    const rep = reportOf(msg.shiftId as string);
    expect(rep.outcomeId).toBe('handoff');
    expect(rep.note).toContain('# Is 6mm ARC enough for deer?');
    expect(rep.note).toMatch(/- Mock claim 1 about the question \[1\]/);
    expect(rep.note).toMatch(/1\. Mock source 1 - https:\/\/example\.test\/research\/1/);
  }, 120_000);

  it('researcher: fetches the transcript of a video source before relying on it', async () => {
    h = await startHarness();
    const fields = {
      mockResearch: {
        claims: [
          {
            text: 'The talk says X',
            url: 'https://video.example.test/watch/1',
            kind: 'video',
            title: 'Talk',
          },
        ],
      },
    };
    const msg = makeResearchShiftStart({ stage: 'research', fields });
    await run(msg);
    expect(reportOf(msg.shiftId as string).note).toContain('video.example.test/watch/1');
    const log = h!.server
      .of('shift.progress')
      .flatMap((p) => p.items)
      .map((i) => i.text)
      .join('\n');
    expect(log).toContain('mock researcher: transcript of https://video.example.test/watch/1: Status: ok');
  }, 120_000);

  it('researcher in a rework round drops the claims the checker could not verify', async () => {
    h = await startHarness();
    const fields = {
      mockResearch: {
        claims: [
          { text: 'Solid claim', url: 'https://example.test/research/1' },
          { text: 'Shaky claim', url: 'https://example.test/research/2', supported: false },
        ],
      },
    };
    const first = makeResearchShiftStart({ stage: 'research', fields });
    await run(first);
    expect(reportOf(first.shiftId as string).note).toContain('Shaky claim');
    const again = makeResearchShiftStart({ stage: 'research', fields, reworkRound: 1 });
    await run(again);
    const note = reportOf(again.shiftId as string).note as string;
    expect(note).toContain('Solid claim');
    expect(note).not.toContain('Shaky claim');
  }, 120_000);

  it('checker: verifies, opens every cited page and publishes the note with its citations', async () => {
    const vault = await startWithVault();
    const msg = makeResearchShiftStart({ stage: 'factcheck', handoffs: researchHandoff(), vault: VAULT });
    expect((await run(msg)).outcome).toBe('reported');
    const data = reportOf(msg.shiftId as string).data;
    expect(data.citations.map((c: any) => c.url)).toEqual([
      'https://example.test/research/1',
      'https://example.test/research/2',
    ]);
    const note = originFile(vault, data.vaultPath);
    expect(parseNoteFrontMatter(note)?.citations).toHaveLength(2);
    expect(note).toContain('6mm ARC delivers about 1500 ft-lb');
  }, 120_000);

  it('checker: a cited video is accepted once its transcript was fetched, the transcript lands in the vault and the note links it', async () => {
    const seen: Record<string, any> = {};
    const VIDEO = 'https://video.example.test/watch/9';
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      const publish = () =>
        ctl.post('/v1/report', {
          report: {
            kind: 'outcome',
            outcomeId: 'published',
            note: 'verified',
            data: {
              content: '# Talk findings\n\nThe talk says reloading helps. [1]',
              citations: [{ url: VIDEO, title: 'The talk' }],
            },
          },
        });
      seen.before = await publish(); // not opened yet
      seen.fetch = await ctl.post('/v1/rpc', { method: 'transcript.fetch', params: { url: VIDEO } });
      seen.ok = await publish();
    });
    const vault = await startWithVault(adapter);
    const msg = makeResearchShiftStart({ stage: 'factcheck', handoffs: researchHandoff(), vault: VAULT });
    expect((await run(msg)).outcome).toBe('reported');
    expect(seen.before.status).toBe(422);
    expect(seen.before.json.error).toMatch(/not pages you opened/);
    const tpath = seen.fetch.json.result.path as string;
    expect(tpath).toMatch(
      /^projects\/shooting\/transcripts\/\d{4}-\d{2}-\d{2}-mock-transcript-[a-z0-9]{1,4}\.md$/,
    );
    expect(seen.ok.status).toBe(200);
    const data = reportOf(msg.shiftId as string).data;
    expect(data.citations[0]).toMatchObject({ url: VIDEO, transcriptPath: tpath });
    expect(originFile(vault, tpath)).toContain('Welcome to the mock talk');
    const note = originFile(vault, data.vaultPath);
    expect(note).toContain('## Transcripts');
    expect(note).toContain(`(../transcripts/${tpath.split('/').pop()})`);
  }, 120_000);

  it('checker action uncited: the first try without citations is refused, then it publishes properly', async () => {
    const vault = await startWithVault();
    const msg = makeResearchShiftStart({
      stage: 'factcheck',
      handoffs: researchHandoff(),
      vault: VAULT,
      fields: { mock: { factcheck: ['uncited'] } },
    });
    expect((await run(msg)).outcome).toBe('reported');
    expect(reportsOf(msg.shiftId as string)).toHaveLength(1);
    const log = h!.server
      .of('shift.progress')
      .flatMap((p) => p.items)
      .map((i) => i.text)
      .join('\n');
    expect(log).toMatch(/publishing without citations was refused.*No citations, no publication/s);
    expect(originLog(vault)[0]).toContain('Research: ');
  }, 120_000);

  it('checker: a draft with an unsupported claim goes back as unsupported and nothing is written', async () => {
    const vault = await startWithVault();
    const msg = makeResearchShiftStart({
      stage: 'factcheck',
      handoffs: researchHandoff(DRAFT.replace('Most states', 'Every state')),
      vault: VAULT,
      fields: {
        mockResearch: {
          claims: [
            {
              text: '6mm ARC delivers about 1500 ft-lb at 300 yards',
              url: 'https://example.test/research/1',
            },
            {
              text: 'Every state set a minimum of 1000 ft-lb for deer',
              url: 'https://example.test/research/2',
              supported: false,
            },
          ],
        },
      },
    });
    expect((await run(msg)).outcome).toBe('reported');
    const rep = reportOf(msg.shiftId as string);
    expect(rep.outcomeId).toBe('unsupported');
    expect(rep.note).toContain('Every state set a minimum');
    expect(originLog(vault)).toHaveLength(1); // only the seed commit
  }, 120_000);
});
