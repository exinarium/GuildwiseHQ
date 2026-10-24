import {
  indexPack,
  PACK_AUTHORING_CAPABILITY,
  PACKS_CAPABILITY,
  packSnapshotOf,
  SESSION_TURNS_CAPABILITY,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bmadFixtureStable } from '../../../packages/shared/test/fixtures/bmad-fixture.ts';
import { followProjectPacks } from '../src/commands/pack-follow.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, MOCK_RUNTIME, ok, pairWorkstation, until, type World } from './helpers/world.ts';

/**
 * R3c: the packs of a project follow its sessions. A member who starts a Discovery or Boardroom session in the project on a
 * workstation that does not hold the project's approved packs is asked (a desk item for them) to let the packs come; a "yes"
 * brings them, a "no" is not asked again soon.
 */
let w: World;
let owner: FakeRunner;
let mem: FakeRunner;
let member: Awaited<ReturnType<typeof w.t.userSession>>;
let memberWs = '';
let packId = '';
let packName = '';
const CAPS = [PACKS_CAPABILITY, PACK_AUTHORING_CAPABILITY, SESSION_TURNS_CAPABILITY];

const lastSync = (r: FakeRunner): Array<Record<string, unknown>> => {
  const cmds = r.of('command').filter((c) => c.command === 'packs.sync');
  return (cmds.at(-1)?.payload.packs as Array<Record<string, unknown>>) ?? [];
};
const asOwner = (method: string, url: string, body?: unknown, expected = 200) =>
  // biome-ignore lint/suspicious/noExplicitAny: response bodies
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );
const asMember = (method: string, url: string, body?: unknown, expected = 200) =>
  // biome-ignore lint/suspicious/noExplicitAny: response bodies
  ok<any>(
    w.t.req(method, url, {
      cookie: member.cookie,
      headers: { 'x-aom-org': w.owner.id },
      ...(body !== undefined ? { body } : {}),
    }),
    expected,
  );
const notices = async () =>
  q(`SELECT id, status, addressee_user_id, body FROM desk_items WHERE subject_key = $1`, [
    `pack_assignment:${packId}:${memberWs}`,
  ]);

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  owner = await FakeRunner.connect(w.baseUrl, w.runnerToken);
  owner.hello({ runtimes: MOCK_RUNTIME, capabilities: CAPS });
  await owner.waitFor('welcome');
  member = await w.t.userSession(uniqueEmail('r3c-follow'));
  await w.t.addOrgMember(w.owner.id, member.id, 'member');
  await asOwner('POST', `/api/projects/${w.projectId}/members`, { email: member.email }, 201);
  const paired = await pairWorkstation(w.t, member, 'follow-desk');
  memberWs = paired.workstationId;
  mem = await FakeRunner.connect(w.baseUrl, paired.runnerToken);
  mem.hello({ runtimes: MOCK_RUNTIME, capabilities: CAPS });
  await mem.waitFor('welcome');
  // a pack added to the project by the Owner, on the Owner's workstation, and approved
  const add = await asOwner(
    'POST',
    '/api/packs',
    {
      preset: 'bmad',
      url: 'https://github.com/x/follow-bmad.git',
      ref: 'v6.12.4',
      scope: 'project',
      projectId: w.projectId,
    },
    201,
  );
  packId = add.pack.id;
  packName = add.pack.name;
  const snap = packSnapshotOf({
    name: packName,
    ref: 'v6.12.4',
    sha: 'c'.repeat(40),
    index: indexPack({ name: packName, adapter: 'auto', tree: bmadFixtureStable() }),
  });
  owner.send('packs.report', { packId, state: 'resolved', snapshot: snap });
  await until(
    async () =>
      (await asOwner('GET', '/api/packs')).packs.find((p: { id: string }) => p.id === packId)?.status ===
      'ready',
  );
  await asOwner('POST', `/api/packs/${packId}/trust`, { sha: snap.sha, contentHash: snap.contentHash });
});
afterAll(async () => {
  owner.close();
  mem.close();
  await w.t.close();
  await closeAdminPool();
});

describe('project packs follow a session to its creator’s workstation', () => {
  it('does nothing for the person who added the pack, or for a session without a project', async () => {
    await asOwner(
      'POST',
      '/api/discovery',
      { title: 'Owner in project', idea: 'x', projectId: w.projectId },
      201,
    );
    await asMember('POST', '/api/discovery', { title: 'No project', idea: 'x' }, 201);
    expect(await notices()).toEqual([]);
    // the Owner's own workstation already holds it (it is the adding admin's)
    expect(
      await followProjectPacks(w.t.app.ctx, {
        orgId: w.owner.id,
        projectId: w.projectId,
        workstationId: w.workstationId,
        userId: w.owner.id,
      }),
    ).toEqual([]);
  });

  it('asks a member who starts a session in the project; nothing reaches their workstation until they accept', async () => {
    const before = mem.of('command').filter((c) => c.command === 'packs.sync').length;
    await asMember(
      'POST',
      '/api/discovery',
      { title: 'Member in project', idea: 'x', projectId: w.projectId },
      201,
    );
    const items = await notices();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: 'open', addressee_user_id: member.id });
    expect(items[0]?.body).toContain('started a session in the project');
    expect(items[0]?.body).toContain(packName);
    // not on the member's list yet; the Owner's workstation still holds it
    await w.t.app.ctx.services.gateway.deliverPending(memberWs);
    expect(lastSync(mem).some((p) => p.packId === packId)).toBe(false);
    void before;
    const holders = (await q('SELECT workstation_ids FROM packs WHERE id=$1', [packId]))[0]
      ?.workstation_ids as string[];
    expect(holders).toContain(memberWs);
    expect(holders).toContain(w.workstationId); // the adding admin's own was kept when a holder was named
    // a second session while the question is open does not ask again
    await asMember('POST', '/api/discovery', { title: 'Second', idea: 'x', projectId: w.projectId }, 201);
    expect(await notices()).toHaveLength(1);
  });

  it('brings the pack once the member accepts, and the session of the project can use it there', async () => {
    const [item] = await notices();
    await asMember(
      'POST',
      `/api/pack-assignments/${packId}/decide`,
      { workstationId: memberWs, accept: true },
      204,
    );
    await w.t.app.ctx.services.gateway.deliverPending(memberWs);
    await until(async () => lastSync(mem).some((p) => p.packId === packId));
    expect(item?.id).toBeTruthy();
    // the Owner's workstation keeps it
    await w.t.app.ctx.services.gateway.deliverPending(w.workstationId);
    expect(
      (await q('SELECT workstation_ids FROM packs WHERE id=$1', [packId]))[0]?.workstation_ids,
    ).toContain(w.workstationId);
  });

  it('does not ask again where the pack already is', async () => {
    const n = (await notices()).length;
    await asMember('POST', '/api/discovery', { title: 'Third', idea: 'x', projectId: w.projectId }, 201);
    expect(await notices()).toHaveLength(n);
  });
});

describe('a "no" is remembered, and some packs are never moved by themselves', () => {
  it('is not asked again for 30 days after a decline', async () => {
    const stranger = await w.t.userSession(uniqueEmail('r3c-follow2'));
    await w.t.addOrgMember(w.owner.id, stranger.id, 'member');
    await asOwner('POST', `/api/projects/${w.projectId}/members`, { email: stranger.email }, 201);
    const paired = await pairWorkstation(w.t, stranger, 'no-thanks');
    const r2 = await FakeRunner.connect(w.baseUrl, paired.runnerToken);
    r2.hello({ runtimes: MOCK_RUNTIME, capabilities: CAPS });
    await r2.waitFor('welcome');
    const asStranger = (method: string, url: string, body?: unknown, expected = 200) =>
      // biome-ignore lint/suspicious/noExplicitAny: response bodies
      ok<any>(
        w.t.req(method, url, {
          cookie: stranger.cookie,
          headers: { 'x-aom-org': w.owner.id },
          ...(body !== undefined ? { body } : {}),
        }),
        expected,
      );
    await asStranger(
      'POST',
      '/api/discovery',
      { title: 'First', idea: 'x', projectId: w.projectId, workstationId: paired.workstationId },
      201,
    );
    const key = `pack_assignment:${packId}:${paired.workstationId}`;
    expect(await q('SELECT 1 FROM desk_items WHERE subject_key=$1', [key])).toHaveLength(1);
    await asStranger(
      'POST',
      `/api/pack-assignments/${packId}/decide`,
      { workstationId: paired.workstationId, accept: false },
      204,
    );
    await asStranger(
      'POST',
      '/api/discovery',
      { title: 'Again', idea: 'x', projectId: w.projectId, workstationId: paired.workstationId },
      201,
    );
    expect(await q('SELECT 1 FROM desk_items WHERE subject_key=$1', [key])).toHaveLength(1);
    const holders = (await q('SELECT workstation_ids FROM packs WHERE id=$1', [packId]))[0]
      ?.workstation_ids as string[];
    expect(holders).not.toContain(paired.workstationId);
    r2.close();
  });

  it('skips a pack that is not approved, one that needs a deploy key, and a workstation that cannot hold packs', async () => {
    const untrusted = await asOwner(
      'POST',
      '/api/packs',
      {
        name: 'untrusted-one',
        preset: 'bmad',
        url: 'https://github.com/x/untrusted-bmad.git',
        ref: 'v1',
        scope: 'project',
        projectId: w.projectId,
      },
      201,
    );
    await q(`UPDATE packs SET pinned_sha=$2 WHERE id=$1`, [untrusted.pack.id, 'd'.repeat(40)]);
    const keyed = await asOwner(
      'POST',
      '/api/packs',
      {
        name: 'keyed-one',
        preset: 'bmad',
        url: 'https://github.com/x/keyed-bmad.git',
        ref: 'v1',
        scope: 'project',
        projectId: w.projectId,
      },
      201,
    );
    await q(
      `UPDATE packs SET pinned_sha=$2, credential_kind='token', trusted=true, trusted_sha=$2, trusted_hash=content_hash WHERE id=$1`,
      [keyed.pack.id, 'e'.repeat(40)],
    );
    const third = await w.t.userSession(uniqueEmail('r3c-follow3'));
    await w.t.addOrgMember(w.owner.id, third.id, 'member');
    const paired = await pairWorkstation(w.t, third, 'plain');
    const r3 = await FakeRunner.connect(w.baseUrl, paired.runnerToken);
    r3.hello({ runtimes: MOCK_RUNTIME, capabilities: [SESSION_TURNS_CAPABILITY] }); // no pack capability
    await r3.waitFor('welcome');
    const done = await followProjectPacks(w.t.app.ctx, {
      orgId: w.owner.id,
      projectId: w.projectId,
      workstationId: paired.workstationId,
      userId: third.id,
    });
    expect(done).toEqual([]);
    for (const id of [untrusted.pack.id, keyed.pack.id])
      expect(
        await q('SELECT 1 FROM desk_items WHERE subject_key LIKE $1', [`pack_assignment:${id}:%`]),
      ).toEqual([]);
    r3.close();
  });
});
