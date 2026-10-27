import { indexPack, PACKS_CAPABILITY, type PackSnapshot, packSnapshotOf } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * A pack approved before the Claude Code plugin layout was read keeps working when a runner that reads it reports the pack: the
 * layout's items wait for the Owner's approval, an older runner does not flip the pack into an integrity failure, and nothing
 * but the real content can pass.
 */
const skill = (n: string) => `---\nname: ${n}\ndescription: The ${n} skill.\n---\n\n# ${n}\n`;
const base = { 'skills/helper/SKILL.md': skill('helper'), LICENSE: 'MIT License\n\nCopyright (c) 2025 X\n' };
const plugin = {
  '.claude-plugin/plugin.json': '{}',
  'agents/guide.md': '---\nname: guide\ndescription: Guides.\n---\n\nYou guide.\n',
  'commands/go.md': '# Go\n\nGo.\n',
};

let w: World;
let r: FakeRunner;
let packId = '';
const SHA = 'e'.repeat(40);
const snapOf = (tree: Record<string, string>): PackSnapshot =>
  packSnapshotOf({ name: 'lay', ref: 'v1', sha: SHA, index: indexPack({ name: 'lay', tree }) });
// biome-ignore lint/suspicious/noExplicitAny: response bodies
const owner = (method: string, url: string, body?: unknown, expected = 200): Promise<any> =>
  ok(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), expected);
const failures = async () =>
  (await q(`SELECT 1 FROM events WHERE type='PackIntegrityFailed' AND stream_id LIKE $1`, [`%${packId}`]))
    .length;
const layoutEvents = async () =>
  (await q(`SELECT 1 FROM events WHERE type='PackLayoutRead' AND stream_id LIKE $1`, [`%${packId}`])).length;
const report = async (snapshot: PackSnapshot) => {
  r.send('packs.report', { packId, state: 'resolved', snapshot });
  // let the server handle it before the next step
  await new Promise((res) => setTimeout(res, 400));
};

const oldSnap = () => snapOf(base); // what a 0.1.61 runner saw
const newSnap = () => snapOf({ ...base, ...plugin }); // what a 0.1.62 runner sees

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [PACKS_CAPABILITY] });
  packId = (
    await owner('POST', '/api/packs', { name: 'lay', url: 'https://github.com/x/lay.git', ref: 'main' }, 201)
  ).pack.id;
  const s = oldSnap();
  r.send('packs.report', { packId, state: 'resolved', snapshot: s });
  await until(async () => (await owner('GET', '/api/packs')).packs[0].status === 'ready');
  await owner('POST', `/api/packs/${packId}/trust`, { sha: s.sha, contentHash: s.contentHash });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('a pack trusted before the plugin layout was read', () => {
  it('the two readers disagree on the whole hash and agree on the legacy one', () => {
    expect(newSnap().contentHash).not.toBe(oldSnap().contentHash);
    expect(newSnap().legacyContentHash).toBe(oldSnap().contentHash);
  });

  it('stays trusted and fails no integrity check when a new runner reports it; the new items are listed, unusable', async () => {
    await report(newSnap());
    expect(await failures()).toBe(0);
    expect(await layoutEvents()).toBe(1);
    const pack = (await owner('GET', `/api/packs/${packId}`)).pack;
    expect(pack.trusted).toBe(true);
    expect(pack.itemCount).toBe(newSnap().items.length);
    const reg = (await owner('GET', '/api/capabilities')).items.filter(
      (i: { pack?: string }) => i.pack === 'lay',
    );
    const by = Object.fromEntries(reg.map((i: { key: string }) => [i.key, i]));
    expect(by['lay:helper']).toMatchObject({ usable: true });
    expect(by['lay:guide']).toMatchObject({ usable: false, unusableReason: 'untrusted' });
    expect(by['lay:go']).toMatchObject({ usable: false });
    // reported again: nothing new
    await report(newSnap());
    expect(await layoutEvents()).toBe(1);
  });

  it('an older and a newer runner do not flip it back and forth', async () => {
    await report(oldSnap());
    await report(newSnap());
    await report(oldSnap());
    expect(await failures()).toBe(0);
    expect(await layoutEvents()).toBe(1);
  });

  it('the new items cannot be hired from before they are approved', async () => {
    const t = await owner('GET', `/api/packs/${packId}/team`);
    expect(t.pendingPluginItems).toBe(2);
    expect(t.agents.map((a: { key: string }) => a.key)).not.toContain('guide');
  });

  it('files that match neither hash are an integrity failure', async () => {
    await report(snapOf({ ...base, 'skills/helper/SKILL.md': skill('helper') + '\nchanged\n' }));
    expect(await failures()).toBe(1);
    // restore: the flag clears with the approved content
    await report(newSnap());
  });

  it('approving the full hash unlocks the new items, and an older runner still passes', async () => {
    const s = newSnap();
    await owner('POST', `/api/packs/${packId}/trust`, { sha: s.sha, contentHash: s.contentHash });
    const reg = (await owner('GET', '/api/capabilities')).items.filter(
      (i: { pack?: string }) => i.pack === 'lay',
    );
    expect(reg.every((i: { usable: boolean }) => i.usable)).toBe(true);
    expect((await owner('GET', `/api/packs/${packId}`)).pack).toMatchObject({
      trusted: true,
      contentHash: s.contentHash,
    });
    const before = await failures();
    await report(oldSnap());
    expect(await failures()).toBe(before);
    expect((await owner('GET', `/api/packs/${packId}/team`)).pendingPluginItems).toBe(0);
  });
});
