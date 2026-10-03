import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, connectMemberRunner, type Member } from './helpers/members.ts';
import { createWorld, fullFields, MOCK_RUNTIME, ok, REPO_SSH, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const dispatcher = () => w.t.app.ctx.services.dispatcher;
const as = (cookie: string) => ({
  get: (url: string) => w.t.req('GET', url, { cookie }),
  post: (url: string, body: unknown = {}) => w.t.req('POST', url, { cookie, body }),
  patch: (url: string, body: unknown = {}) => w.t.req('PATCH', url, { cookie, body }),
});
const owner = () => as(w.owner.cookie);

/** The latest `vault.configure` command the runner received (full state). */
const lastConfigure = (runner: FakeRunner) =>
  runner
    .of('command')
    .filter((c) => c.command === 'vault.configure')
    .at(-1)?.payload as any;
async function configured(runner: FakeRunner, pred: (p: any) => boolean) {
  await until(
    async () => {
      const p = lastConfigure(runner);
      return p && pred(p);
    },
    4000,
    'vault.configure',
  );
  return lastConfigure(runner);
}

describe('registering vaults', () => {
  it('a user registers one work and one personal vault by URL; the site stores no content', async () => {
    const work = await owner().post('/api/vaults', {
      kind: 'work',
      remoteUrl: 'git@example.test:me/work.git',
    });
    expect(work.status).toBe(201);
    expect(work.body).toMatchObject({
      kind: 'work',
      name: 'Work vault',
      remoteUrl: 'git@example.test:me/work.git',
      syncIntervalSec: 300,
      projectId: null,
      canEdit: true,
    });
    expect(work.body.workstations).toEqual([
      expect.objectContaining({ workstationId: w.workstationId, localPath: null, paused: false }),
    ]);
    expect((await owner().post('/api/vaults', { kind: 'work', remoteUrl: 'x' })).body.error.code).toBe(
      'vault_exists',
    );
    const personal = await owner().post('/api/vaults', {
      kind: 'personal',
      remoteUrl: '/srv/personal.git',
      syncIntervalSec: 60,
    });
    expect(personal.status).toBe(201);
    expect(personal.body.syncIntervalSec).toBe(60);
    // validation
    expect((await owner().post('/api/vaults', { kind: 'project', remoteUrl: 'x' })).status).toBe(400);
    expect(
      (await owner().post('/api/vaults', { kind: 'work', remoteUrl: 'x', projectId: w.projectId })).status,
    ).toBe(400);
    expect(
      (await owner().post('/api/vaults', { kind: 'personal', remoteUrl: 'y', syncIntervalSec: 0 })).status,
    ).toBe(400);
  });

  it('a personal vault is visible only to its owner; the owner can edit the URL and interval', async () => {
    const other = await w.t.userSession(uniqueEmail('nosy'));
    expect((await as(other.cookie).get('/api/vaults')).body.vaults).toEqual([]);
    const list = (await owner().get('/api/vaults')).body.vaults;
    expect(list.map((v: any) => v.kind)).toEqual(['personal', 'work']);
    const work = list.find((v: any) => v.kind === 'work');
    expect((await as(other.cookie).patch(`/api/vaults/${work.id}`, { remoteUrl: 'evil' })).status).toBe(404);
    const patched = await owner().patch(`/api/vaults/${work.id}`, {
      remoteUrl: '/srv/work.git',
      syncIntervalSec: 120,
      name: 'Work notes',
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      remoteUrl: '/srv/work.git',
      syncIntervalSec: 120,
      name: 'Work notes',
    });
    expect(
      (await q(`SELECT type FROM events WHERE type LIKE 'Vault%' ORDER BY seq`)).map((e) => e.type),
    ).toEqual(['VaultRegistered', 'VaultRegistered', 'VaultUpdated']);
  });

  it('the runner gets the full vault set (replace semantics) with the DevOps identity, also after changes', async () => {
    const p = await configured(
      r,
      (c) => c.vaults.length === 2 && c.vaults.some((v: any) => v.remoteUrl === '/srv/work.git'),
    );
    expect(p.identity).toEqual({
      name: expect.stringMatching(/ \(aom\)$/),
      email: expect.stringMatching(/@agents\.aom\.invalid$/),
    });
    expect(p.workstationName).toBe('Desk');
    expect(p.vaults.map((v: any) => v.kind).sort()).toEqual(['personal', 'work']);
    // a reconnect re-sends it (at most one configure row per workstation)
    r.close();
    r = await w.connectRunner();
    const again = await configured(r, (c) => c.vaults.length === 2);
    expect(again.vaults).toHaveLength(2);
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='vault.configure'`)).toHaveLength(1);
  });

  it("the runner reports clones and sync status; the vault list shows them for the viewer's workstations", async () => {
    const work = (await owner().get('/api/vaults')).body.vaults.find((v: any) => v.kind === 'work');
    // the clone location arrives with the next hello
    r.send('hello', {
      runnerVersion: '0.0.0-test',
      protocol: 1,
      platform: 'linux',
      hostname: 'fake-host',
      runtimes: MOCK_RUNTIME,
      repos: [{ remoteUrl: REPO_SSH, localPath: '/tmp/toy', headBranch: 'main' }],
      vaults: [{ vaultId: work.id, localPath: '/vaults/work', clean: true }],
      activeShifts: [],
      outboxPending: 0,
    });
    await until(
      async () =>
        (await owner().get('/api/vaults')).body.vaults.find((v: any) => v.kind === 'work').workstations[0]
          .localPath,
    );
    expect(
      (await owner().get('/api/vaults')).body.vaults.find((v: any) => v.kind === 'work').workstations[0]
        .localPath,
    ).toBe('/vaults/work');
    r.send('vault.status', {
      vaultId: work.id,
      lastPullAt: '2026-10-03T10:00:00.000Z',
      lastPushAt: '2026-10-03T10:01:00.000Z',
    });
    r.send('vault.status', {
      vaultId: randomUUID(),
      lastPullAt: null,
      lastPushAt: null,
      error: 'unknown vault is ignored',
    });
    await until(
      async () =>
        (await owner().get('/api/vaults')).body.vaults.find((v: any) => v.kind === 'work').workstations[0]
          .lastPushAt,
    );
    const s = (await owner().get('/api/vaults')).body.vaults.find((v: any) => v.kind === 'work')
      .workstations[0];
    expect(s).toMatchObject({
      lastPullAt: '2026-10-03T10:00:00.000Z',
      lastPushAt: '2026-10-03T10:01:00.000Z',
      lastError: null,
    });
    r.send('vault.status', {
      vaultId: work.id,
      lastPullAt: null,
      lastPushAt: null,
      error: 'remote unreachable',
    });
    await until(
      async () =>
        (await owner().get('/api/vaults')).body.vaults.find((v: any) => v.kind === 'work').workstations[0]
          .lastError,
    );
    const s2 = (await owner().get('/api/vaults')).body.vaults.find((v: any) => v.kind === 'work')
      .workstations[0];
    expect(s2.lastError).toBe('remote unreachable');
    expect(s2.lastPushAt).toBe('2026-10-03T10:01:00.000Z'); // errors do not erase the last success
  });
});

describe('sync conflicts', () => {
  it('a conflict pauses the vault on that workstation and raises one pinned escalation until resolved', async () => {
    const work = (await owner().get('/api/vaults')).body.vaults.find((v: any) => v.kind === 'work');
    const id = r.send('vault.conflict', { vaultId: work.id, files: ['projects/toy/PROJECT.md'] });
    await r.waitFor('ack', (f) => f.ackOf === id);
    const ev = await q(`SELECT payload FROM events WHERE type='VaultSyncConflict'`);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({
      vaultId: work.id,
      workstationId: w.workstationId,
      files: ['projects/toy/PROJECT.md'],
    });
    expect(ev[0]!.payload.deskItemId).toMatch(/^[0-9a-f-]{36}$/);
    const desk = await q(`SELECT kind, subkind, status, pinned, org_id FROM desk_items WHERE id=$1`, [
      ev[0]!.payload.deskItemId,
    ]);
    expect(desk).toEqual([
      { kind: 'escalation', subkind: 'vault_conflict', status: 'open', pinned: true, org_id: w.owner.id },
    ]);
    const s = (await owner().get('/api/vaults')).body.vaults.find((v: any) => v.id === work.id)
      .workstations[0];
    expect(s).toMatchObject({ paused: true, conflictFiles: ['projects/toy/PROJECT.md'] });
    // a repeated report while paused is acknowledged but not duplicated
    const id2 = r.send('vault.conflict', { vaultId: work.id, files: ['projects/toy/PROJECT.md'] });
    await r.waitFor('ack', (f) => f.ackOf === id2);
    expect(await q(`SELECT 1 FROM events WHERE type='VaultSyncConflict'`)).toHaveLength(1);
  });

  it('resolving resumes syncing: VaultConflictResolved and vault.configure{resume}', async () => {
    const work = (await owner().get('/api/vaults')).body.vaults.find((v: any) => v.kind === 'work');
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect(
      (
        await as(stranger.cookie).post(`/api/vaults/${work.id}/resolve-conflict`, {
          workstationId: w.workstationId,
        })
      ).status,
    ).toBe(404);
    const done = await owner().post(`/api/vaults/${work.id}/resolve-conflict`, {
      workstationId: w.workstationId,
    });
    expect(done.status).toBe(200);
    expect(done.body.workstations[0]).toMatchObject({ paused: false, conflictFiles: [] });
    const p = await configured(r, (c) => c.resume.includes(work.id));
    expect(p.resume).toEqual([work.id]);
    expect(await q(`SELECT 1 FROM events WHERE type='VaultConflictResolved'`)).toHaveLength(1);
    expect((await q(`SELECT status FROM desk_items WHERE subkind='vault_conflict'`))[0]!.status).toBe(
      'answered',
    );
    expect(
      (await owner().post(`/api/vaults/${work.id}/resolve-conflict`, { workstationId: w.workstationId }))
        .status,
    ).toBe(409);
  });
});

describe('sync conflicts resolved on the desk', () => {
  it('acknowledging the desk escalation resumes sync like the vault page does', async () => {
    const work = (await owner().get('/api/vaults')).body.vaults.find((v: any) => v.kind === 'work');
    const id = r.send('vault.conflict', { vaultId: work.id, files: ['a.md'] });
    await r.waitFor('ack', (f) => f.ackOf === id);
    const item = (await q(`SELECT id FROM desk_items WHERE subkind='vault_conflict' AND status='open'`))[0]!;
    const before = r.of('command').filter((c) => c.command === 'vault.configure').length;
    const res = await owner().post(`/api/desk/${item.id}/resolve`, { resolution: 'acknowledged' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('answered');
    await until(
      async () => r.of('command').filter((c) => c.command === 'vault.configure').length === before + 1,
      4000,
      'vault.configure{resume}',
    );
    expect(lastConfigure(r).resume).toEqual([work.id]);
    const s = (await owner().get('/api/vaults')).body.vaults.find((v: any) => v.id === work.id)
      .workstations[0];
    expect(s).toMatchObject({ paused: false, conflictFiles: [] });
  });
});

describe('project vaults and shared projects', () => {
  let m: Member;
  let mr: FakeRunner;
  it('only the project owner registers the project vault; members see it and their runner syncs it', async () => {
    m = await addMember(w, 'vmember');
    mr = await connectMemberRunner(w, m);
    const noVault = await configured(mr, () => true);
    expect(noVault.vaults).toEqual([]); // the owner's work and personal vaults never reach a member
    expect(
      (await as(m.cookie).post('/api/vaults', { kind: 'project', projectId: w.projectId, remoteUrl: 'x' }))
        .status,
    ).toBe(403);
    const pv = await owner().post('/api/vaults', {
      kind: 'project',
      projectId: w.projectId,
      remoteUrl: '/srv/toy-vault.git',
      name: 'Toy knowledge',
    });
    expect(pv.status).toBe(201);
    expect(pv.body).toMatchObject({ kind: 'project', projectId: w.projectId, canEdit: true });
    expect(
      (await owner().post('/api/vaults', { kind: 'project', projectId: w.projectId, remoteUrl: 'y' })).body
        .error.code,
    ).toBe('vault_exists');
    const mine = (await as(m.cookie).get('/api/vaults')).body.vaults;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'project', name: 'Toy knowledge', canEdit: false });
    expect((await as(m.cookie).patch(`/api/vaults/${pv.body.id}`, { remoteUrl: 'evil' })).status).toBe(403);
    const cfg = await configured(mr, (c) => c.vaults.length === 1);
    expect(cfg.vaults[0]).toMatchObject({
      vaultId: pv.body.id,
      kind: 'project',
      remoteUrl: '/srv/toy-vault.git',
      projectId: w.projectId,
    });
    // the owner's runner syncs all three
    expect((await configured(r, (c) => c.vaults.length === 3)).vaults.map((v: any) => v.kind).sort()).toEqual(
      ['personal', 'project', 'work'],
    );
  });

  it('removing the member removes the project vault from their runner', async () => {
    const res = await w.t.req('DELETE', `/api/projects/${w.projectId}/members/${m.id}`, {
      cookie: w.owner.cookie,
    });
    expect(res.status).toBe(200);
    await configured(mr, (c) => c.vaults.length === 0 && c.resume !== undefined);
    expect(lastConfigure(mr).vaults).toEqual([]);
    mr.close();
  });
});

describe('a card shift sees only its domain vault', () => {
  const workId = () => q(`SELECT id FROM vaults WHERE kind='work'`).then((x) => x[0]!.id as string);
  const personalId = () => q(`SELECT id FROM vaults WHERE kind='personal'`).then((x) => x[0]!.id as string);

  it('a work project gets the work vault, a personal project the personal vault, with their project folders', async () => {
    await q(`DELETE FROM workstation_vaults WHERE vault_id IN (SELECT id FROM vaults WHERE kind='project')`);
    await q(`DELETE FROM vaults WHERE kind='project'`);
    const personal = await ok<any>(
      owner().post('/api/projects', {
        key: 'PERS',
        name: 'Personal things',
        domain: 'personal',
        vaultFolder: 'projects/hobbies',
      }),
      201,
    );
    await ok(
      owner().post(`/api/projects/${personal.project.id}/repos`, {
        name: 'toy',
        remoteUrl: 'https://github.com/acme/toy.git',
      }),
      201,
    );
    await w.hire('Pat', 'builder', 'junior');
    const workCard = await w.card({ title: 'Work card' });
    const from = r.received.length;
    await dispatcher().run();
    const workStart = await r.waitFor('shift.start', (f) => f.agent.name === 'Pat', 5000, from);
    expect(workStart.brief.card.id).toBe(workCard.id);
    expect(workStart.vault).toEqual({ vaultId: await workId(), kind: 'work', folder: 'projects/toy' });

    // finish the work shift so the (single) builder is free for the personal card
    r.accepted(workStart.shiftId);
    r.started(workStart.shiftId, {
      path: '/w/1',
      branchName: 'b',
      baseBranch: 'main',
      created: true,
      headSha: 'a',
    });
    await until(
      async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='running'`, [workStart.shiftId]))[0],
    );
    r.report(workStart.shiftId, { kind: 'outcome', outcomeId: 'handoff', note: 'done', data: {} });
    r.ended(workStart.shiftId, 'reported');
    await until(
      async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='ended'`, [workStart.shiftId]))[0],
    );
    await q(`UPDATE cards SET status='cancelled' WHERE project_id=$1`, [w.projectId]);

    const persCard = await ok<any>(
      owner().post('/api/cards', {
        projectId: personal.project.id,
        title: 'Personal card',
        cardType: 'feature',
        fields: fullFields(),
        completionAction: 'merge',
        specify: true,
      }),
      201,
    );
    const from2 = r.received.length;
    await dispatcher().run();
    const persStart = await r.waitFor(
      'shift.start',
      (f) => f.brief.card.id === persCard.card.id,
      5000,
      from2,
    );
    expect(persStart.vault).toEqual({
      vaultId: await personalId(),
      kind: 'personal',
      folder: 'projects/hobbies',
    });
    expect(persStart.vault?.vaultId).not.toBe(workStart.vault?.vaultId);
    r.accepted(persStart.shiftId);
    r.ended(persStart.shiftId, 'stopped');
  });

  it('a project without a registered vault of its domain has none', async () => {
    await q(`DELETE FROM workstation_vaults WHERE vault_id IN (SELECT id FROM vaults WHERE kind='work')`);
    await q(`DELETE FROM vaults WHERE kind='work'`);
    const card = await w.card({ title: 'No vault card' });
    const from = r.received.length;
    await dispatcher().run();
    const start = await r.waitFor('shift.start', (f) => f.brief.card.id === card.id, 5000, from);
    expect(start.vault).toBeNull();
    r.accepted(start.shiftId);
    r.ended(start.shiftId, 'stopped');
  });

  it("a project vault wins over the owner's domain vault", async () => {
    const pv = await ok<any>(
      owner().post('/api/vaults', { kind: 'project', projectId: w.projectId, remoteUrl: '/srv/pv.git' }),
      201,
    );
    await q(`UPDATE cards SET status='cancelled' WHERE project_id=$1 AND status IN ('queued','claimed')`, [
      w.projectId,
    ]);
    await q(`UPDATE shifts SET status='ended' WHERE status <> 'ended'`);
    await q(
      `UPDATE cards SET claim_id=NULL, claimed_by_agent_id=NULL, claim_workstation_id=NULL, claim_shift_id=NULL, lease_expires_at=NULL`,
    );
    const card = await w.card({ title: 'Project vault card' });
    const from = r.received.length;
    await dispatcher().run();
    const start = await r.waitFor('shift.start', (f) => f.brief.card.id === card.id, 5000, from);
    expect(start.vault).toEqual({ vaultId: pv.id, kind: 'project', folder: 'projects/toy' });
    r.accepted(start.shiftId);
    r.ended(start.shiftId, 'stopped');
  });
});

describe('repo-less cards need the vault on the workstation', () => {
  it('with a registered domain vault only agents whose workstation holds a clone may claim', async () => {
    const research = await ok<any>(
      owner().post('/api/projects', {
        key: 'RSCH',
        name: 'Research',
        workflowKey: 'research',
        domain: 'personal',
      }),
      201,
    );
    const vault = (await q(`SELECT id FROM vaults WHERE kind='personal'`))[0]!;
    await w.hire('Rhea', 'researcher', 'junior');
    const card = await ok<any>(
      owner().post('/api/cards', {
        projectId: research.project.id,
        title: 'What is a vault',
        cardType: 'research',
        fields: { question: 'What?', depth: 'quick' },
        specify: true,
      }),
      201,
    );
    expect(card.card.status).toBe('queued');
    const from = r.received.length;
    await dispatcher().run();
    // the workstation has no clone of the personal vault yet: not claimable
    expect(
      r.received.slice(from).filter((f) => f.type === 'shift.start' && f.agent.name === 'Rhea'),
    ).toHaveLength(0);
    expect((await q('SELECT status FROM cards WHERE id=$1', [card.card.id]))[0]!.status).toBe('queued');
    // the runner reports the clone (hello / vault.status upsert this row)
    await q(
      `INSERT INTO workstation_vaults (workstation_id, vault_id, local_path) VALUES ($1,$2,'/vaults/p') ON CONFLICT DO NOTHING`,
      [w.workstationId, vault.id],
    );
    await dispatcher().run();
    const start = await r.waitFor('shift.start', (f) => f.agent.name === 'Rhea', 5000, from);
    expect(start.brief.card.id).toBe(card.card.id);
    expect(start.vault).toMatchObject({ kind: 'personal', folder: 'projects/rsch' });
    r.accepted(start.shiftId);
    r.ended(start.shiftId, 'stopped');
  });

  it('a domain without any vault stays claimable by every agent', async () => {
    await q(`DELETE FROM workstation_vaults`);
    await q(`DELETE FROM vaults`);
    const rp = (await q(`SELECT id FROM projects WHERE key='RSCH'`))[0]!;
    const card = await ok<any>(
      owner().post('/api/cards', {
        projectId: rp.id,
        title: 'Second question',
        cardType: 'research',
        fields: { question: 'Why?', depth: 'quick' },
        specify: true,
      }),
      201,
    );
    const from = r.received.length;
    await dispatcher().run();
    const start = await r.waitFor(
      'shift.start',
      (f) => f.brief.card.id === card.card.id || f.agent.name === 'Rhea',
      5000,
      from,
    );
    expect(start.vault).toBeNull();
    r.accepted(start.shiftId);
    r.ended(start.shiftId, 'stopped');
  });
});
