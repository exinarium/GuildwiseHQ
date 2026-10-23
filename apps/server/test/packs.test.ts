import { randomUUID } from 'node:crypto';
import { indexPack, PACKS_CAPABILITY, type PackSnapshot, packSnapshotOf } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bmadFixtureStable } from '../../../packages/shared/test/fixtures/bmad-fixture.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** Capability packs on the server: events, projection, trust gating, update flow, rebuild equality, isolation. */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [PACKS_CAPABILITY] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

// biome-ignore lint/suspicious/noExplicitAny: a response body
const call = (
  method: string,
  url: string,
  body?: unknown,
  expected = 200,
  cookie = w.owner.cookie,
  org?: string,
) =>
  ok<any>(
    w.t.req(method, url, {
      cookie,
      ...(org ? { headers: { 'x-aom-org': org } } : {}),
      ...(body !== undefined ? { body } : {}),
    }),
    expected,
  );

const snapshotOf = (tree: Record<string, string>, sha: string, ref = 'v6.12.4'): PackSnapshot =>
  packSnapshotOf({ name: 'bmad', ref, sha, index: indexPack({ name: 'bmad', adapter: 'auto', tree }) });

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
let packId = '';
let snap1: PackSnapshot;

const syncs = () => r.of('command').filter((c) => c.command === 'packs.sync');
const lastSync = () => syncs().at(-1)?.payload.packs as Array<Record<string, unknown>>;
const events = async (type: string) =>
  (await q(`SELECT count(*)::int AS n FROM events WHERE type=$1`, [type]))[0]?.n as number;

describe('adding a pack', () => {
  it('refuses credentials in the URL, reserved names and non-managers', async () => {
    await call('POST', '/api/packs', { url: 'https://u:p@github.com/a/b.git', ref: 'v1' }, 400);
    await call('POST', '/api/packs', { url: 'https://github.com/a/b.git', ref: 'v1', name: 'persona' }, 400);
    const m = await w.t.userSession(uniqueEmail('member'));
    await w.t.addOrgMember(w.owner.id, m.id, 'member');
    await call('GET', '/api/packs', undefined, 403, m.cookie, w.owner.id);
    await call(
      'POST',
      '/api/packs',
      { url: 'https://github.com/a/b.git', ref: 'v1' },
      403,
      m.cookie,
      w.owner.id,
    );
  });

  it('records PackAdded from the BMAD preset and asks the workstation to fetch it', async () => {
    const preset = (
      await call(
        'POST',
        '/api/packs',
        { preset: 'bmad', url: 'https://github.com/bmad-code-org/BMAD-METHOD.git', ref: 'v6.12.4' },
        201,
      )
    ).pack;
    packId = preset.id;
    expect(preset).toMatchObject({
      name: 'bmad',
      status: 'pending',
      trusted: false,
      preset: 'bmad',
      adapter: 'bmad',
    });
    expect(preset.attribution).toMatch(/MIT/);
    await until(async () => lastSync()?.length === 1);
    expect(lastSync()).toEqual([
      expect.objectContaining({
        packId,
        name: 'bmad',
        pinnedSha: null,
        trusted: null,
        scriptsEnabled: false,
      }),
    ]);
    await call(
      'POST',
      '/api/packs',
      { preset: 'bmad', url: 'https://github.com/bmad-code-org/BMAD-METHOD.git', ref: 'v1' },
      409,
    );
  });
});

describe('resolving, pinning and the trust gate', () => {
  it('pins the commit the first workstation resolved and lists its capabilities as not usable', async () => {
    snap1 = snapshotOf(bmadFixtureStable(), SHA1);
    r.send('packs.report', { packId, state: 'resolved', snapshot: snap1 });
    await until(async () => (await call('GET', '/api/packs')).packs[0].status === 'ready');
    const p = (await call('GET', `/api/packs/${packId}`)).pack;
    expect(p).toMatchObject({
      pinnedSha: SHA1,
      contentHash: snap1.contentHash,
      trusted: false,
      hasScripts: true,
      license: 'MIT',
    });
    expect(p.snapshot.items.length).toBeGreaterThan(5);
    // a second report of another commit does not move the pin
    r.send('packs.report', { packId, state: 'resolved', snapshot: snapshotOf(bmadFixtureStable(), SHA2) });
    await r.barrier();
    expect((await call('GET', `/api/packs/${packId}`)).pack.pinnedSha).toBe(SHA1);

    const all = (await call('GET', '/api/capabilities')).items;
    const analyst = all.find((i: { key: string }) => i.key === 'bmad:analyst');
    expect(analyst).toMatchObject({
      source: 'pack',
      usable: false,
      unusableReason: 'untrusted',
      packId,
      icon: '📊',
    });
    expect(
      (await call('GET', '/api/capabilities?usable=true')).items.some(
        (i: { source: string }) => i.source === 'pack',
      ),
    ).toBe(false);
  });

  it('keeps an untrusted pack persona out of sessions', async () => {
    const res = await w.t.req('POST', '/api/sessions', {
      cookie: w.owner.cookie,
      body: {
        kind: 'boardroom',
        title: 'Untrusted cast',
        participants: [{ kind: 'persona', refId: 'bmad:analyst', seat: 'Analyst' }],
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/unknown_persona|not in the registry|persona/);
  });

  it('refuses an approval for a commit or hash the owner did not review', async () => {
    await call('POST', `/api/packs/${packId}/trust`, { sha: SHA2, contentHash: snap1.contentHash }, 409);
    await call('POST', `/api/packs/${packId}/trust`, { sha: SHA1, contentHash: 'f'.repeat(64) }, 409);
    await call('POST', `/api/packs/${packId}/scripts`, { enabled: true }, 409); // not approved yet
  });

  it('approves the reviewed commit and content hash, tells the workstations, and makes the capabilities usable', async () => {
    const before = syncs().length;
    const p = (
      await call('POST', `/api/packs/${packId}/trust`, { sha: SHA1, contentHash: snap1.contentHash })
    ).pack;
    expect(p.trusted).toBe(true);
    await until(async () => syncs().length > before);
    expect(lastSync()[0]).toMatchObject({
      pinnedSha: SHA1,
      trusted: { sha: SHA1, contentHash: snap1.contentHash },
      scriptsEnabled: false,
    });
    const items = (await call('GET', '/api/capabilities?usable=true')).items;
    expect(items.find((i: { key: string }) => i.key === 'bmad:analyst')).toMatchObject({
      usable: true,
      source: 'pack',
    });
    expect(items.find((i: { key: string }) => i.key === 'bmad:brainstorming')).toMatchObject({
      hasScripts: true,
      tags: expect.arrayContaining(['discovery']),
    });
  });

  it('lets a trusted pack persona into a session', async () => {
    const res = await w.t.req('POST', '/api/sessions', {
      cookie: w.owner.cookie,
      body: {
        kind: 'boardroom',
        title: 'Trusted cast',
        participants: [{ kind: 'persona', refId: 'bmad:analyst', seat: 'Analyst' }],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  });

  it('enables scripts only for an approved pack, and revoking approval turns both off', async () => {
    expect((await call('POST', `/api/packs/${packId}/scripts`, { enabled: true })).pack.scriptsEnabled).toBe(
      true,
    );
    await until(async () => (lastSync()[0] as { scriptsEnabled: boolean }).scriptsEnabled === true);
    const p = (await call('POST', `/api/packs/${packId}/revoke`)).pack;
    expect(p).toMatchObject({ trusted: false, scriptsEnabled: false });
    await until(async () => (lastSync()[0] as { trusted: unknown }).trusted === null);
    expect(
      (await call('GET', '/api/capabilities?usable=true')).items.some(
        (i: { source: string }) => i.source === 'pack',
      ),
    ).toBe(false);
    await call('POST', `/api/packs/${packId}/trust`, { sha: SHA1, contentHash: snap1.contentHash });
  });
});

describe('integrity', () => {
  it('flags the pack when a workstation reports other content for the pinned commit, and clears it when the files are right again', async () => {
    const tampered = { ...bmadFixtureStable() };
    const k = Object.keys(tampered).find((x) => x.endsWith('prd-template.md')) as string;
    tampered[k] = '# tampered\n';
    r.send('packs.report', { packId, state: 'resolved', snapshot: snapshotOf(tampered, SHA1) });
    await until(async () => (await call('GET', '/api/packs')).packs[0].integrityFailed === true);
    const items = (await call('GET', '/api/capabilities')).items;
    expect(items.find((i: { key: string }) => i.key === 'bmad:analyst')).toMatchObject({
      usable: false,
      unusableReason: 'integrity',
    });
    r.send('packs.report', { packId, state: 'resolved', snapshot: snap1 });
    await until(async () => (await call('GET', '/api/packs')).packs[0].integrityFailed === false);
    r.send('packs.report', {
      packId,
      state: 'integrity',
      expected: snap1.contentHash,
      actual: 'c'.repeat(64),
      sha: SHA1,
    });
    await until(async () => (await call('GET', '/api/packs')).packs[0].integrityFailed === true);
    r.send('packs.report', { packId, state: 'resolved', snapshot: snap1 });
    await until(async () => (await call('GET', '/api/packs')).packs[0].integrityFailed === false);
  });
});

describe('updates are offered, never applied', () => {
  const changed = () => {
    const t = { ...bmadFixtureStable() };
    t['src/bmm-skills/plan/bmad-prd/assets/prd-template.md'] = '# PRD v2\n';
    t['src/bmm-skills/ship/bmad-dev-story/scripts/go.sh'] = 'echo\n';
    return t;
  };

  it('queues a check on an online workstation', async () => {
    await call('POST', `/api/packs/${packId}/check`, { ref: 'v6.13.0' }, 202);
    const c = await r.waitFor('command', (f) => f.command === 'pack.check');
    expect(c.payload).toEqual({ packId, ref: 'v6.13.0' });
  });

  it('stores the update with a diff the server computed, and leaves the pin alone', async () => {
    const next = snapshotOf(changed(), SHA2, 'v6.13.0');
    // the runner's own diff is not trusted: a bogus one is ignored
    r.send('packs.report', { packId, state: 'update', snapshot: next, diff: { hasChanges: false } });
    await until(async () => !!(await call('GET', '/api/packs')).packs[0].update);
    const p = (await call('GET', `/api/packs/${packId}`)).pack;
    expect(p.pinnedSha).toBe(SHA1);
    expect(p.update.sha).toBe(SHA2);
    expect(p.update.diff.changedCapabilities.map((c: { id: string }) => c.id).sort()).toEqual([
      'playbook:bmad:prd',
      'skill:bmad:dev-story',
    ]);
    expect(p.update.diff.scriptsAdded.length).toBe(1);
    expect(p.updateSnapshot.sha).toBe(SHA2);
    // the registry still serves the pinned commit
    expect(
      (await call('GET', '/api/capabilities?usable=true')).items.find(
        (i: { key: string }) => i.key === 'bmad:analyst',
      )?.sha,
    ).toBe(SHA1);
  });

  it('only accepts the commit the owner reviewed', async () => {
    await call('POST', `/api/packs/${packId}/accept-update`, { sha: 'c'.repeat(40) }, 409);
  });

  it('accepting moves the pin and the ref, keeps the approval for a pack that had it, and switches scripts back off', async () => {
    await call('POST', `/api/packs/${packId}/scripts`, { enabled: true });
    const before = syncs().length;
    const p = (await call('POST', `/api/packs/${packId}/accept-update`, { sha: SHA2 })).pack;
    expect(p).toMatchObject({
      pinnedSha: SHA2,
      ref: 'v6.13.0',
      update: null,
      trusted: true,
      scriptsEnabled: false,
    });
    expect(p.contentHash).toBe(snapshotOf(changed(), SHA2, 'v6.13.0').contentHash);
    await until(async () => (lastSync()?.[0] as { pinnedSha?: string } | undefined)?.pinnedSha === SHA2);
    expect(syncs().length).toBeGreaterThan(before);
    expect(lastSync()[0]).toMatchObject({ pinnedSha: SHA2, ref: 'v6.13.0', scriptsEnabled: false });
  });

  it('reports nothing new as up to date', async () => {
    r.send('packs.report', { packId, state: 'current', sha: SHA2 });
    await until(async () => (await call('GET', '/api/packs')).packs[0].lastCheckedAt !== null);
  });

  it('shows a failed check as an error without failing the pack', async () => {
    r.send('packs.report', { packId, state: 'failed', message: 'could not reach the host' });
    await until(async () => (await call('GET', '/api/packs')).packs[0].error === 'could not reach the host');
    expect((await call('GET', '/api/packs')).packs[0].status).toBe('ready');
  });
});

describe('project repository capabilities', () => {
  it('stores what a checkout carries, by project, and lists it only for that project', async () => {
    const item = {
      key: 'repo-skill',
      kind: 'skill',
      name: 'repo-skill',
      description: 'From the repo',
      hash: 'd'.repeat(64),
      source: 'project-repo',
    };
    r.send('capabilities.project.report', { projectId: w.projectId, items: [item], issues: [] });
    await until(async () =>
      (await call('GET', `/api/capabilities?projectId=${w.projectId}`)).items.some(
        (i: { key: string }) => i.key === 'repo-skill',
      ),
    );
    expect(
      (await call('GET', '/api/capabilities')).items.some((i: { key: string }) => i.key === 'repo-skill'),
    ).toBe(false);
    // a report for a project of another organization is ignored
    const other = await w.t.userSession(uniqueEmail('other'));
    const before = await events('ProjectCapabilitiesReported');
    r.send('capabilities.project.report', { projectId: randomUUID(), items: [item], issues: [] });
    await r.barrier();
    expect(await events('ProjectCapabilitiesReported')).toBe(before);
    void other;
  });
});

describe('isolation, removal and rebuild', () => {
  it('shows another organization nothing of the pack and refuses its reports', async () => {
    const o = await w.t.userSession(uniqueEmail('stranger'));
    expect((await call('GET', '/api/packs', undefined, 200, o.cookie)).packs).toEqual([]);
    await call('GET', `/api/packs/${packId}`, undefined, 404, o.cookie);
    await call(
      'POST',
      `/api/packs/${packId}/trust`,
      { sha: SHA2, contentHash: 'f'.repeat(64) },
      404,
      o.cookie,
    );
    expect(
      (await call('GET', '/api/capabilities', undefined, 200, o.cookie)).items.some(
        (i: { source: string }) => i.source === 'pack',
      ),
    ).toBe(false);
  });

  it('rebuilds the same projection from the events', async () => {
    const snapshot = async () => JSON.stringify(await q('SELECT * FROM packs ORDER BY id'));
    const idx = async () =>
      JSON.stringify(await q('SELECT * FROM project_capability_index ORDER BY project_id, kind, key'));
    const [a, b] = [await snapshot(), await idx()];
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snapshot()).toBe(a);
    expect(await idx()).toBe(b);
  });

  it('removes a pack: gone from the registry, and the workstation is told to drop it', async () => {
    const before = syncs().length;
    await call('DELETE', `/api/packs/${packId}`, undefined, 204);
    await until(async () => syncs().length > before);
    expect(lastSync()).toEqual([]);
    expect((await call('GET', '/api/packs')).packs).toEqual([]);
    expect(
      (await call('GET', '/api/capabilities')).items.some((i: { source: string }) => i.source === 'pack'),
    ).toBe(false);
    // the name can be used again
    await call('POST', '/api/packs', { url: 'https://github.com/a/bmad.git', ref: 'v1', name: 'bmad' }, 201);
  });
});
