import {
  indexPack,
  PACKS_CAPABILITY,
  packSnapshotOf,
  SESSION_TURNS_CAPABILITY,
  SESSION_VERBS_CAPABILITY,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bmadFixtureStable } from '../../../packages/shared/test/fixtures/bmad-fixture.ts';
import { startIntakeIn } from '../src/commands/intake.ts';
import { applyProjectCapabilitiesReport, queuePacksSync } from '../src/commands/packs.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { kit, q } from './helpers/sessions-r2.ts';
import { createWorld, until, type World } from './helpers/world.ts';

/**
 * Revision R2: "Hand to BA" waits for a BA (and never makes a second intake), project-scoped packs apply in sessions of the
 * project, and the review list of project-repository skills (reviewed, changed, blocked) with its effect on the registry
 * and on the runners.
 */
let w: World;
let r: FakeRunner;
let K: ReturnType<typeof kit>;
const CAPS = [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY, PACKS_CAPABILITY];
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: CAPS });
  K = kit(w, () => r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const approvedPrd = async (title: string) => {
  const s = await K.createDiscovery({ title });
  const start = await K.nextStart(s.threadId, K.role('facilitator'));
  expect(
    (await K.call(start.chatId, 'session.draft', { kind: 'prd', content: '# PRD\n\nR1: do it' })).ok,
  ).toBe(true);
  await K.finish(start);
  const docId = (await K.discovery(s.threadId)).documents[0].id;
  await K.owner('POST', `/api/documents/${docId}/status`, { status: 'in_review' });
  await K.owner('POST', `/api/documents/${docId}/status`, { status: 'approved' });
  return { s, docId };
};

describe('Hand to BA with the BA offline', () => {
  it('queues, hands the document off, starts the intake when the BA is online, and never makes a second one after a crash', async () => {
    await w.hire('Ben', 'ba', 'senior');
    const { s, docId } = await approvedPrd('Offline BA');
    // the BA's workstation goes offline
    r.close();
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId));
    expect((await K.discovery(s.threadId)).baStatus).toBe('offline');
    const res = await K.raw('POST', `/api/discovery/${s.threadId}/hand-to-ba`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intakeId: null, queued: true });
    expect(res.body.state.config.handoff).toMatchObject({ state: 'queued', reason: 'ba_offline' });
    expect((await K.owner('GET', `/api/documents/${docId}`)).document.status).toBe('handed_off');
    // a BA is hired, so no "hire one" notice
    expect(
      await q(`SELECT 1 FROM desk_items WHERE subkind='handoff_needs_ba' AND status='open'`),
    ).toHaveLength(0);
    await w.t.app.ctx.services.discovery.sweep();
    expect((await K.discovery(s.threadId)).config.intakeId ?? null).toBeNull();

    // the BA comes back; meanwhile an intake for the PRD was created but the session never recorded it (a crash)
    r = await w.connectRunner({ capabilities: CAPS });
    await startIntakeIn(
      w.t.app.ctx,
      { id: w.owner.id },
      w.owner.id,
      { note: 'Discovery handoff (made just before the crash)' },
      { linkedDocIds: [docId] },
    );
    await w.t.app.ctx.services.discovery.sweep();
    await w.t.app.ctx.services.discovery.sweep();
    const cfg = (await K.discovery(s.threadId)).config;
    expect(cfg.handoff ?? null).toBeNull();
    expect(cfg.intakeId).toBeTruthy();
    expect(
      await q(`SELECT 1 FROM intakes WHERE linked_doc_ids @> $1::jsonb`, [JSON.stringify([docId])]),
    ).toHaveLength(1);
    // replay keeps the same picture
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect((await K.discovery(s.threadId)).config.intakeId).toBe(cfg.intakeId);
    // the BA's chat for the adopted intake starts; finish it so the slot is free
    const ba = await r.waitFor(
      'chat.start',
      (f) => !K.seen.has(f.chatId) && f.threadId !== s.threadId,
      15_000,
    );
    r.send('chat.done', {
      chatId: ba.chatId,
      threadId: ba.threadId,
      messageText: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it('with no BA hired it recommends hiring one: a desk notice that closes once the intake starts', async () => {
    const { s, docId } = await approvedPrd('No BA at all');
    await q(`UPDATE agents SET status='retired' WHERE role_key='ba'`);
    const res = await K.raw('POST', `/api/discovery/${s.threadId}/hand-to-ba`);
    expect(res.body).toMatchObject({ queued: true });
    expect(res.body.state.baStatus).toBe('none');
    expect(res.body.state.config.handoff.reason).toBe('no_ba');
    const open = await q(
      `SELECT id, title FROM desk_items WHERE subkind='handoff_needs_ba' AND status='open'`,
    );
    expect(open).toHaveLength(1);
    expect(open[0].title).toMatch(/Hire a business analyst/);
    // hiring one (the built-in ba role) starts the intake on the next sweep, and the notice is closed
    await q(`UPDATE agents SET status='active' WHERE role_key='ba'`);
    await w.t.app.ctx.services.discovery.sweep();
    expect((await K.discovery(s.threadId)).config.intakeId).toBeTruthy();
    expect(
      await q(`SELECT 1 FROM desk_items WHERE subkind='handoff_needs_ba' AND status='open'`),
    ).toHaveLength(0);
    expect(
      await q(`SELECT 1 FROM intakes WHERE linked_doc_ids @> $1::jsonb`, [JSON.stringify([docId])]),
    ).toHaveLength(1);
    const ba = await r.waitFor(
      'chat.start',
      (f) => !K.seen.has(f.chatId) && f.threadId !== s.threadId,
      15_000,
    );
    K.seen.add(ba.chatId);
    r.send('chat.done', {
      chatId: ba.chatId,
      threadId: ba.threadId,
      messageText: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });
});

describe('packs scoped to a project', () => {
  it('apply in a session that has the project, not in one without', async () => {
    const add = await K.owner(
      'POST',
      '/api/packs',
      {
        preset: 'bmad',
        url: 'https://github.com/x/proj-bmad.git',
        ref: 'v6.12.4',
        scope: 'project',
        projectId: w.projectId,
      },
      201,
    );
    const packId = add.pack.id as string;
    const snap = packSnapshotOf({
      name: add.pack.name,
      ref: 'v6.12.4',
      sha: 'b'.repeat(40),
      index: indexPack({ name: add.pack.name, adapter: 'auto', tree: bmadFixtureStable() }),
    });
    r.send('packs.report', { packId, state: 'resolved', snapshot: snap });
    await until(
      async () =>
        (await K.owner('GET', '/api/packs')).packs.find((p: any) => p.id === packId)?.status === 'ready',
    );
    await K.owner('POST', `/api/packs/${packId}/trust`, { sha: snap.sha, contentHash: snap.contentHash });
    const key = `${add.pack.name}:brainstorming`;
    const without = await K.raw('POST', '/api/discovery', { title: 'No project', idea: 'y', playbook: key });
    expect(without.status).toBe(400);
    const withProject = await K.raw('POST', '/api/discovery', {
      title: 'In project',
      idea: 'y',
      playbook: key,
      projectId: w.projectId,
    });
    expect(withProject.status, JSON.stringify(withProject.body)).toBe(201);
    // the registry agrees
    const a = (await K.owner('GET', '/api/capabilities?kind=persona&usable=true')).items;
    const b = (await K.owner('GET', `/api/capabilities?kind=persona&usable=true&projectId=${w.projectId}`))
      .items;
    expect(a.some((i: any) => i.key === `${add.pack.name}:analyst`)).toBe(false);
    expect(b.some((i: any) => i.key === `${add.pack.name}:analyst`)).toBe(true);
    await K.cleanup();
  });
});

describe('review list of project-repository skills', () => {
  const hash = (c: string) => c.repeat(64);
  const report = async (items: Array<{ key: string; hash: string; path?: string }>) => {
    await applyProjectCapabilitiesReport(w.t.app.ctx, { id: w.workstationId, userId: w.owner.id }, {
      type: 'capabilities.project.report',
      projectId: w.projectId,
      items: items.map((i) => ({
        kind: 'skill',
        key: i.key,
        name: i.key,
        description: `${i.key} skill`,
        hash: i.hash,
        source: 'project-repo',
        ...(i.path ? { path: i.path } : {}),
      })),
      issues: [],
    } as never);
  };
  const list = async () => (await K.owner('GET', '/api/capabilities/project-skills')).items as any[];
  const review = (key: string, h: string, status: string) =>
    K.raw('POST', '/api/capabilities/project-skills/review', {
      projectId: w.projectId,
      kind: 'skill',
      key,
      hash: h,
      status,
    });

  it("lists what the project repository carries with repo, path and hash, and records the owner's decision", async () => {
    await report([
      { key: 'deploy-helper', hash: hash('a'), path: '.claude/skills/deploy-helper' },
      { key: 'lint-fixer', hash: hash('b'), path: '.agents/skills/lint-fixer' },
    ]);
    let items = await list();
    const dep = items.find((i) => i.key === 'deploy-helper');
    expect(dep).toMatchObject({
      projectKey: 'TOY',
      path: '.claude/skills/deploy-helper',
      hash: hash('a'),
      status: 'unreviewed',
    });
    expect(typeof dep.repo === 'string' || dep.repo === null).toBe(true);
    // it must be exactly the file looked at
    expect((await review('deploy-helper', hash('f'), 'reviewed')).status).toBe(409);
    expect((await review('deploy-helper', hash('a'), 'reviewed')).status).toBe(200);
    items = await list();
    expect(items.find((i) => i.key === 'deploy-helper')).toMatchObject({
      status: 'reviewed',
      reviewedHash: hash('a'),
    });
    // the file changes: the review no longer covers it
    await report([
      { key: 'deploy-helper', hash: hash('c'), path: '.claude/skills/deploy-helper' },
      { key: 'lint-fixer', hash: hash('b'), path: '.agents/skills/lint-fixer' },
    ]);
    expect((await list()).find((i) => i.key === 'deploy-helper').status).toBe('changed');
    // only Owners and Admins see or change the list
    const m = await w.t.userSession('r2-skills-member@example.test');
    await w.t.addOrgMember(w.owner.id, m.id, 'member');
    expect((await K.as(m.cookie)('GET', '/api/capabilities/project-skills')).status).toBe(403);
  });

  const lastSync = async () =>
    (
      await q(
        `SELECT payload FROM runner_commands WHERE workstation_id=$1 AND type='packs.sync' ORDER BY created_at DESC LIMIT 1`,
        [w.workstationId],
      )
    )[0].payload;
  const usable = async () =>
    (await K.owner('GET', `/api/capabilities?kind=skill&usable=true&projectId=${w.projectId}`)).items.map(
      (i: any) => i.key,
    );
  const noticeOpen = async () =>
    (
      await q(`SELECT id FROM desk_items WHERE subject_key=$1 AND status='open'`, [
        `project_skills_review:${w.projectId}`,
      ])
    ).length;

  it('Q52: an unreviewed or changed skill is unusable until reviewed at its current hash; the runner is told which hashes; a desk notice shows what waits', async () => {
    await report([{ key: 'fresh-skill', hash: hash('d'), path: '.claude/skills/fresh-skill' }]);
    // never reviewed: not usable, listed (unusable) in the registry with the reason, a notice is open
    expect(await usable()).not.toContain('fresh-skill');
    const all = (await K.owner('GET', `/api/capabilities?kind=skill&projectId=${w.projectId}`))
      .items as any[];
    expect(all.find((i) => i.key === 'fresh-skill')).toMatchObject({
      usable: false,
      unusableReason: 'unreviewed',
    });
    expect(await noticeOpen()).toBe(1);
    await queuePacksSync(w.t.app.ctx.pool, w.workstationId);
    expect((await lastSync()).reviewed).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ key: 'fresh-skill' })]),
    );
    // reviewed at the hash: usable, on the runner's reviewed list, the notice closes
    expect((await review('fresh-skill', hash('d'), 'reviewed')).status).toBe(200);
    expect(await usable()).toContain('fresh-skill');
    expect(await noticeOpen()).toBe(0);
    expect((await lastSync()).reviewed).toContainEqual({
      projectId: w.projectId,
      kind: 'skill',
      key: 'fresh-skill',
      hash: hash('d'),
    });
    // the file changes: unusable again with reason "changed", and a notice returns
    await report([{ key: 'fresh-skill', hash: hash('e'), path: '.claude/skills/fresh-skill' }]);
    expect(await usable()).not.toContain('fresh-skill');
    const again = (await K.owner('GET', `/api/capabilities?kind=skill&projectId=${w.projectId}`))
      .items as any[];
    expect(again.find((i) => i.key === 'fresh-skill')).toMatchObject({
      usable: false,
      unusableReason: 'changed',
    });
    expect(await noticeOpen()).toBe(1);
    // an owner who reviews the old hash cannot approve the new file
    expect((await review('fresh-skill', hash('d'), 'reviewed')).status).toBe(409);
    expect((await review('fresh-skill', hash('e'), 'reviewed')).status).toBe(200);
    expect(await usable()).toContain('fresh-skill');
    // the sessions of that project see a persona only when reviewed (a member session uses usableOnly registry)
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(await usable()).toContain('fresh-skill');
  });

  it("a blocked skill is unusable: out of the registry and on the runners' blocked list; clearing the block makes it unreviewed again; replay-safe", async () => {
    await report([{ key: 'lint-fixer', hash: hash('b'), path: '.agents/skills/lint-fixer' }]);
    expect((await review('lint-fixer', hash('b'), 'reviewed')).status).toBe(200);
    expect(await usable()).toContain('lint-fixer');
    expect((await review('lint-fixer', hash('b'), 'blocked')).status).toBe(200);
    expect((await list()).find((i) => i.key === 'lint-fixer').status).toBe('blocked');
    expect(await usable()).not.toContain('lint-fixer');
    // the runners are told with the next packs.sync
    await queuePacksSync(w.t.app.ctx.pool, w.workstationId);
    const cmd = await lastSync();
    expect(cmd.blocked).toContainEqual({ projectId: w.projectId, kind: 'skill', key: 'lint-fixer' });
    expect(cmd.reviewed ?? []).not.toContainEqual(expect.objectContaining({ key: 'lint-fixer' }));
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect((await list()).find((i) => i.key === 'lint-fixer').status).toBe('blocked');
    expect((await review('lint-fixer', hash('b'), 'unreviewed')).status).toBe(200);
    expect(await usable()).not.toContain('lint-fixer');
    await queuePacksSync(w.t.app.ctx.pool, w.workstationId);
    expect((await lastSync()).blocked).toEqual([]);
  });
});
