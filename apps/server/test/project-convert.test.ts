import { randomUUID } from 'node:crypto';
import { streamId, VaultWriteCommandSchema } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hygieneSpecFor } from '../src/commands/hygiene.ts';
import { phasePass } from '../src/dispatcher/phases.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { designer, responderRole, triagerRole, workflowInput } from './helpers/designer.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let orgId = '';
const SYSTEM = { kind: 'system' as const, id: null };

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  // a custom workflow with no repository stage, for the any-to-any matrix
  await ok(owner('POST', '/api/departments', { name: 'support' }), 201);
  await designer(w).publish('roles', triagerRole());
  await designer(w).publish('roles', responderRole());
  await designer(w).publish('workflows', workflowInput('support'));
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const as = (cookie: string) => (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie, body });
const URL1 = 'https://github.com/acme/reload.git';
let n = 0;
const newProject = async (workflowKey: string, withRepo = workflowKey === 'code') => {
  n++;
  const key = `P${String.fromCharCode(65 + (n % 26))}${String.fromCharCode(65 + Math.floor(n / 26))}`;
  const p = await ok<any>(owner('POST', '/api/projects', { key, name: `Project ${key}`, workflowKey }), 201);
  if (withRepo)
    await ok(
      owner('POST', `/api/projects/${p.project.id}/repos`, {
        name: 'app',
        remoteUrl: `https://github.com/acme/${key.toLowerCase()}.git`,
      }),
      201,
    );
  return { id: p.project.id as string, key };
};
const researchCard = async (projectId: string, title: string, specify = true) =>
  (
    await ok<any>(
      owner('POST', '/api/cards', {
        projectId,
        title,
        cardType: 'research',
        fields: { question: `${title}?`, depth: 'standard' },
        specify,
      }),
      201,
    )
  ).card;
const featureCard = async (projectId: string, title: string, specify = false) =>
  (
    await ok<any>(
      owner('POST', '/api/cards', {
        projectId,
        title,
        cardType: 'feature',
        fields: {
          context: 'c',
          requirements: 'r',
          acceptanceCriteria: ['a'],
          affectedAreas: 'x',
          constraints: 'n',
          testPlan: 't',
        },
        completionAction: 'merge',
        specify,
      }),
      201,
    )
  ).card;
const project = async (id: string) =>
  (await q('SELECT * FROM projects WHERE id=$1', [id]))[0] as Record<string, any>;
const status = async (cardId: string) =>
  (await q('SELECT status FROM cards WHERE id=$1', [cardId]))[0]?.status as string;
const convert = (id: string, body: Record<string, unknown>, who = owner) =>
  who('POST', `/api/projects/${id}/convert`, body);
const events = (type: string, projectId: string) =>
  q('SELECT payload, seq FROM events WHERE type=$1 AND project_id=$2 ORDER BY seq', [type, projectId]);
const columns = async (projectId: string) =>
  ((await ok<any>(owner('GET', `/api/board?projectId=${projectId}`))).columns as any[]).map((c) => c.name);
const deskOf = async (subkind: string) =>
  ((await ok<any>(owner('GET', '/api/desk'))).items as any[]).filter(
    (i) => i.subkind === subkind && i.status === 'open',
  );

describe('research cards in any project', () => {
  it('a research card in a code project runs the research workflow, takes no repository and adds its columns', async () => {
    const code = await newProject('code');
    const before = await columns(code.id);
    expect(before).not.toContain('Research');
    const rc = await researchCard(code.id, 'What to build');
    const detail = await ok<any>(owner('GET', `/api/cards/${rc.id}`));
    expect(detail.card).toMatchObject({ workflowKey: 'research', stage: 'research', cardType: 'research' });
    expect(detail.card.repoId).toBeNull();
    const after = await columns(code.id);
    expect(after).toContain('Research');
    expect(after).toContain('Fact check');
    expect(after.indexOf('Fact check')).toBeLessThan(after.indexOf('Done'));
    const board = await ok<any>(owner('GET', `/api/board?projectId=${code.id}`));
    const onBoard = board.columns.flatMap((c: any) => c.cards).find((c: any) => c.id === rc.id);
    expect(onBoard.workflowKey).toBe('research');
    // a card type neither workflow knows is refused
    const bad = await owner('POST', '/api/cards', {
      projectId: code.id,
      title: 'x',
      cardType: 'feed',
      fields: {},
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_card_type');
    // once the research card is cancelled the extra columns go
    await ok(owner('POST', `/api/cards/${rc.id}/cancel`, { reason: 'not needed' }));
    expect(await columns(code.id)).toEqual(before);
  });

  it('a schedule may create research cards in a code project', async () => {
    const code = await newProject('code');
    const s = await owner('POST', '/api/schedules', {
      name: 'Weekly research',
      trigger: { kind: 'cron', cron: '0 7 * * 1', timezone: 'UTC' },
      action: {
        kind: 'create_card',
        projectId: code.id,
        template: {
          title: 'Weekly scan',
          cardType: 'research',
          fields: { question: 'What is new?', depth: 'quick' },
        },
      },
    });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
  });
});

describe('the research stage', () => {
  it('refuses repositories and a plain workflow change; the project started as research', async () => {
    const res = await newProject('research');
    const add = await owner('POST', `/api/projects/${res.id}/repos`, { name: 'x', remoteUrl: URL1 });
    expect(add.status).toBe(409);
    expect(add.body.error.code).toBe('research_stage_no_repos');
    const patch = await owner('PATCH', `/api/projects/${res.id}`, { workflowKey: 'code' });
    expect(patch.status).toBe(400);
    expect(patch.body.error.code).toBe('use_convert');
    expect(await project(res.id)).toMatchObject({ workflow_key: 'research', started_as: 'research' });
    const dto = (await ok<any>(owner('GET', `/api/projects/${res.id}`))).project;
    expect(dto).toMatchObject({ startedAs: 'research', publishedNotes: 0, convertedAt: null });
  });

  it('hygiene skips a research-stage project that still holds a legacy repository', async () => {
    const res = await newProject('research');
    const repoId = randomUUID();
    await seed(w, [
      {
        streamId: streamId.project(res.id),
        event: {
          type: 'ProjectRepoAdded',
          payload: {
            projectId: res.id,
            repoId,
            name: 'legacy',
            remoteUrl: 'https://github.com/acme/legacy.git',
            remoteUrlNormalized: 'github.com/acme/legacy',
          },
        },
        actor: SYSTEM,
        scope: { orgId, projectId: res.id, audience: 'project' },
      },
    ]);
    await q(
      `INSERT INTO workstation_repos (workstation_id, project_repo_id, local_path, reported_at) VALUES ($1,$2,'/tmp/legacy',now())`,
      [w.workstationId, repoId],
    );
    const spec = await hygieneSpecFor(w.t.app.ctx.pool, w.workstationId, 'manual');
    expect(spec.repos.map((x) => x.repoId)).toEqual([w.repoId]);
    await q('DELETE FROM workstation_repos WHERE project_repo_id=$1', [repoId]);
  });

  it('phases take research cards as members, and a published note resolves them', async () => {
    const code = await newProject('code');
    const phase = await ok<any>(
      owner('POST', `/api/projects/${code.id}/phases`, { name: 'Discovery', followups: [] }),
      201,
    );
    const rc = await researchCard(code.id, 'Member research');
    await ok(owner('PUT', `/api/cards/${rc.id}/phase`, { phaseId: phase.id }));
    await seed(w, [
      {
        streamId: streamId.card(rc.id),
        event: {
          type: 'ResearchPublished',
          payload: {
            cardId: rc.id,
            projectId: code.id,
            vaultPath: `projects/${code.key.toLowerCase()}/general/member.md`,
            title: 'Member note',
            citations: [
              { url: 'https://example.test/a', title: 'A', accessedAt: '2026-10-03T08:00:00.000Z' },
            ],
            excerpt: 'x',
          },
        },
        actor: SYSTEM,
        scope: { orgId, projectId: code.id, audience: 'project' },
      },
    ]);
    await phasePass(w.t.app.ctx);
    const done = (await events('PhaseCompleted', code.id))[0];
    expect(done?.payload.cardOutcomes).toMatchObject([{ ref: rc.ref, outcome: 'published' }]);
    const detail = await ok<any>(owner('GET', `/api/phases/${phase.id}`));
    expect(detail.members.find((m: any) => m.ref === rc.ref)).toMatchObject({
      outcome: 'published',
      status: 'done',
    });
  });

  it('refuses deploy and regression follow-ups where there is nothing to run them on', async () => {
    const res = await newProject('research');
    const refused = await owner('POST', `/api/projects/${res.id}/phases`, {
      name: 'Plan',
      followups: [{ kind: 'regression', platform: 'web', note: '' }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('followup_needs_repos');
    const ok2 = await owner('POST', `/api/projects/${res.id}/phases`, { name: 'Plan', followups: [] });
    expect(ok2.status).toBe(201);
  });
});

describe('converting a project', () => {
  it('research to code: adds the repository, keeps the started-as, writes one ProjectConverted', async () => {
    const res = await newProject('research');
    const kept = await researchCard(res.id, 'Still open');
    const preview = await ok<any>(owner('GET', `/api/projects/${res.id}/convert-preview?toWorkflowKey=code`));
    expect(preview).toMatchObject({
      fromWorkflowKey: 'research',
      toWorkflowKey: 'code',
      usesRepos: true,
      activeRepos: 0,
      suggested: 'code',
    });
    expect(preview.foreignCards.map((c: any) => c.ref)).toEqual([kept.ref]);
    const out = await ok<any>(
      convert(res.id, { toWorkflowKey: 'code', repos: [{ name: 'reload', remoteUrl: URL1 }], note: 'Go' }),
    );
    expect(out).toMatchObject({ status: 'converted', keptCards: 1, cancelledCards: 0 });
    expect(out.project).toMatchObject({ workflowKey: 'code', startedAs: 'research' });
    expect(out.repos).toHaveLength(1);
    const p = await project(res.id);
    expect(p).toMatchObject({ workflow_key: 'code', started_as: 'research', converted_by: w.owner.id });
    expect(p.converted_at).toBeTruthy();
    const ev = await events('ProjectConverted', res.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({
      fromWorkflowKey: 'research',
      toWorkflowKey: 'code',
      cancelledCardIds: [],
      cardDecisions: [{ cardId: kept.id, decision: 'keep' }],
      note: 'Go',
      by: w.owner.id,
    });
    expect(ev[0]?.payload.repoIds).toHaveLength(1);
    // the kept research card still queues on the research workflow; its columns show next to the code ones
    expect(await status(kept.id)).toBe('queued');
    expect(await columns(res.id)).toEqual(expect.arrayContaining(['Research', 'Fact check', 'Done']));
    // repositories are possible now
    const more = await owner('POST', `/api/projects/${res.id}/repos`, {
      name: 'second',
      remoteUrl: 'https://github.com/acme/second.git',
    });
    expect(more.status).toBe(201);
    // the conversion shows on the project's history as one event, never twice
    const again = await convert(res.id, { toWorkflowKey: 'code', repos: [] });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('same_workflow');
  });

  it('keep or cancel per card: cancelled cards close with the reason "Project converted"', async () => {
    const res = await newProject('research');
    const a = await researchCard(res.id, 'Keep me');
    const b = await researchCard(res.id, 'Cancel me');
    const c = await researchCard(res.id, 'Draft one', false);
    const out = await ok<any>(
      convert(res.id, {
        toWorkflowKey: 'code',
        repos: [{ name: 'reload', remoteUrl: URL1 }],
        defaultDecision: 'keep',
        cardDecisions: { [b.id]: 'cancel' },
      }),
    );
    expect(out).toMatchObject({ keptCards: 2, cancelledCards: 1 });
    expect(await status(a.id)).toBe('queued');
    expect(await status(b.id)).toBe('cancelled');
    expect(await status(c.id)).toBe('draft');
    const cancelled = (
      await q(`SELECT payload FROM events WHERE type='CardCancelled' AND stream_id=$1`, [streamId.card(b.id)])
    )[0]?.payload;
    expect(cancelled).toMatchObject({ reason: 'Project converted', cause: 'project_converted' });
    expect((await events('ProjectConverted', res.id))[0]?.payload.cancelledCardIds).toEqual([b.id]);
    // the whole list may be cancelled by default
    const res2 = await newProject('research');
    const d = await researchCard(res2.id, 'One');
    const e = await researchCard(res2.id, 'Two');
    await ok(
      convert(res2.id, {
        toWorkflowKey: 'code',
        repos: [{ name: 'reload', remoteUrl: 'https://github.com/acme/other.git' }],
        defaultDecision: 'cancel',
        cardDecisions: { [e.id]: 'keep' },
      }),
    );
    expect([await status(d.id), await status(e.id)]).toEqual(['cancelled', 'queued']);
  });

  it('validates: a repository for code, known targets, known cards, no duplicates', async () => {
    const res = await newProject('research');
    const noRepo = await convert(res.id, { toWorkflowKey: 'code', repos: [] });
    expect(noRepo.status).toBe(400);
    expect(noRepo.body.error.code).toBe('repo_required');
    expect((await convert(res.id, { toWorkflowKey: 'nope', repos: [] })).body.error.code).toBe(
      'unknown_workflow',
    );
    expect((await convert(res.id, { toWorkflowKey: 'feed', repos: [] })).body.error.code).toBe(
      'invalid_target',
    );
    expect((await convert(res.id, { toWorkflowKey: 'research', repos: [] })).body.error.code).toBe(
      'same_workflow',
    );
    const badCard = await convert(res.id, {
      toWorkflowKey: 'code',
      repos: [{ name: 'a', remoteUrl: URL1 }],
      cardDecisions: { [randomUUID()]: 'cancel' },
    });
    expect(badCard.body.error.code).toBe('invalid_card');
    const dup = await convert(res.id, {
      toWorkflowKey: 'code',
      repos: [
        { name: 'a', remoteUrl: URL1 },
        { name: 'b', remoteUrl: URL1 },
      ],
    });
    expect(dup.status).toBe(409);
    // nothing changed
    expect((await project(res.id)).workflow_key).toBe('research');
    expect(await events('ProjectConverted', res.id)).toHaveLength(0);
  });

  it('any to any: research to a custom workflow, back to research, code to custom', async () => {
    const a = await newProject('research');
    const rc = await researchCard(a.id, 'Custom soon');
    const toCustom = await ok<any>(
      convert(a.id, { toWorkflowKey: 'support', repos: [], defaultDecision: 'keep' }),
    );
    expect(toCustom).toMatchObject({ status: 'converted', keptCards: 1 });
    expect((await project(a.id)).workflow_key).toBe('support');
    expect(await status(rc.id)).toBe('queued');
    // custom -> research: the research card is placed (no decision), nothing foreign
    const back = await ok<any>(owner('GET', `/api/projects/${a.id}/convert-preview?toWorkflowKey=research`));
    expect(back.foreignCards).toEqual([]);
    expect(back.placedCards).toBe(1);
    await ok(convert(a.id, { toWorkflowKey: 'research', repos: [] }));
    expect((await project(a.id)).workflow_key).toBe('research');
    expect((await project(a.id)).started_as).toBe('research');
    // code -> custom: the open feature card cannot be placed; cancelling it
    const c = await newProject('code');
    const fc = await featureCard(c.id, 'Old feature', true);
    const pv = await ok<any>(owner('GET', `/api/projects/${c.id}/convert-preview?toWorkflowKey=support`));
    expect(pv).toMatchObject({ usesRepos: false, activeRepos: 1 });
    expect(pv.foreignCards.map((x: any) => x.ref)).toEqual([fc.ref]);
    await ok(convert(c.id, { toWorkflowKey: 'support', repos: [], defaultDecision: 'cancel' }));
    expect(await status(fc.id)).toBe('cancelled');
    expect((await project(c.id)).workflow_key).toBe('support');
    // custom -> code needs its repository: the project already has one
    await ok(convert(c.id, { toWorkflowKey: 'code', repos: [] }));
    expect((await project(c.id)).workflow_key).toBe('code');
  });

  it('only the organization Owner and Admins convert', async () => {
    const res = await newProject('research');
    const member = await w.t.userSession(uniqueEmail('plain'));
    await ok(owner('POST', `/api/projects/${res.id}/members`, { email: member.email }), 201);
    await ok(w.t.req('POST', `/api/projects/${res.id}/members/accept`, { cookie: member.cookie }));
    const asMember = as(member.cookie);
    const denied = await convert(
      res.id,
      { toWorkflowKey: 'code', repos: [{ name: 'a', remoteUrl: URL1 }] },
      asMember,
    );
    expect(denied.status).toBe(403);
    expect((await asMember('GET', `/api/projects/${res.id}/convert-preview?toWorkflowKey=code`)).status).toBe(
      403,
    );
    expect((await project(res.id)).workflow_key).toBe('research');
    // an Admin of the organization may
    const admin = await w.t.userSession(uniqueEmail('admin'));
    await w.t.addOrgMember(orgId, admin.id, 'admin');
    const okRes = await convert(
      res.id,
      { toWorkflowKey: 'code', repos: [{ name: 'a', remoteUrl: URL1 }] },
      as(admin.cookie),
    );
    expect(okRes.status, JSON.stringify(okRes.body)).toBe(200);
    expect((await project(res.id)).converted_by).toBe(admin.id);
  });

  it('asks the working-branch question for each repository it added', async () => {
    const res = await newProject('research');
    await ok(
      convert(res.id, {
        toWorkflowKey: 'code',
        repos: [
          { name: 'one', remoteUrl: 'https://github.com/acme/one.git' },
          { name: 'two', remoteUrl: 'https://github.com/acme/two.git', workingBranch: 'develop' },
        ],
      }),
    );
    await w.t.app.ctx.notifier.flush();
    const repos = await q('SELECT id, name FROM project_repos WHERE project_id=$1 ORDER BY name', [res.id]);
    const asked = await until(
      async () => {
        const items = await q(
          `SELECT data, title FROM desk_items WHERE project_id=$1 AND subkind='working_branch' AND status='open'`,
          [res.id],
        );
        return items.length === 2 ? items : false;
      },
      5000,
      'two branch questions',
    );
    expect(asked.map((i) => i.data.reason)).toEqual(['conversion', 'conversion']);
    expect(asked.map((i) => i.data.repoId).sort()).toEqual(repos.map((x) => x.id).sort());
    expect(asked.some((i) => /Keep develop/.test(i.title))).toBe(true);
    expect(asked.some((i) => /Which branch is the working branch of one/.test(i.title))).toBe(true);
  });

  it('lists the research notes in PROJECT.md of the project vault', async () => {
    const vault = await ok<any>(
      owner('POST', '/api/vaults', { kind: 'work', remoteUrl: 'git@example.test:srv/work.git' }),
      201,
    );
    const res = await newProject('research');
    const rc = await researchCard(res.id, 'Published one');
    const folder = `projects/${res.key.toLowerCase()}`;
    await seed(w, [
      {
        streamId: streamId.card(rc.id),
        event: {
          type: 'ResearchPublished',
          payload: {
            cardId: rc.id,
            projectId: res.id,
            vaultPath: `${folder}/general/caliber-study.md`,
            title: 'Caliber study',
            citations: [
              { url: 'https://example.test/1', title: 'One', accessedAt: '2026-10-03T08:00:00.000Z' },
              { url: 'https://example.test/2', title: 'Two', accessedAt: '2026-10-03T08:00:00.000Z' },
            ],
            excerpt: 'x',
          },
        },
        actor: SYSTEM,
        scope: { orgId, projectId: res.id, audience: 'project' },
      },
    ]);
    const from = r.received.length;
    await ok(convert(res.id, { toWorkflowKey: 'code', repos: [{ name: 'reload', remoteUrl: URL1 }] }));
    const cmd = await r.waitFor(
      'command',
      (f) => f.command === 'vault.write' && String(f.payload?.path).endsWith('/PROJECT.md'),
      15_000,
      from,
    );
    const payload = VaultWriteCommandSchema.parse(cmd.payload);
    expect(payload).toMatchObject({
      vaultId: vault.id,
      path: `${folder}/PROJECT.md`,
      mode: 'section',
      section: { id: 'research-index' },
    });
    expect(payload.content).toContain('- [Caliber study](general/caliber-study.md)');
    expect(payload.content).toContain(rc.ref);
    expect(payload.content).toContain('2 citations');
    expect(payload.content).toContain('converted to the Code workflow');
    const dto = (await ok<any>(owner('GET', `/api/projects/${res.id}`))).project;
    expect(dto.publishedNotes).toBe(1);
  });

  it('a rebuild reproduces the converted project, its cards and the waiting conversion', async () => {
    const res = await newProject('research');
    const cancelled = await researchCard(res.id, 'Gone');
    await ok(
      convert(res.id, {
        toWorkflowKey: 'code',
        repos: [{ name: 'reload', remoteUrl: URL1 }],
        cardDecisions: { [cancelled.id]: 'cancel' },
      }),
    );
    const waiting = await newProject('research');
    await ok(
      convert(waiting.id, {
        toWorkflowKey: 'code',
        repos: [{ create: { name: 'acme/rebuilt', visibility: 'private' } }],
      }),
    );
    const read = async () => ({
      projects: await q(
        'SELECT id, workflow_key, started_as, converted_at, converted_by, pending_conversion FROM projects ORDER BY id',
      ),
      cards: await q('SELECT id, status, workflow_version_id FROM cards ORDER BY id'),
      repos: await q('SELECT id, project_id, removed_at FROM project_repos ORDER BY id'),
      requests: await q(
        'SELECT id, status, requested_by_user_id, requested_by_agent_id FROM repo_requests ORDER BY id',
      ),
    });
    const before = await read();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await read()).toEqual(before);
    expect(before.projects.find((p) => p.id === waiting.id)?.pending_conversion).toMatchObject({
      toWorkflowKey: 'code',
    });
  });
});

describe('a new repository from the convert dialog', () => {
  const runnerCommand = (from: number) =>
    r.waitFor('command', (f: any) => f.command === 'repo.create', 15_000, from) as Promise<any>;

  it('waits for the owner approval and the runner, then converts', async () => {
    const res = await newProject('research');
    const rc = await researchCard(res.id, 'Waiting');
    const out = await ok<any>(
      convert(res.id, {
        toWorkflowKey: 'code',
        repos: [{ create: { name: 'acme/fresh', visibility: 'private', description: 'New' } }],
      }),
    );
    expect(out).toMatchObject({ status: 'waiting' });
    expect(out.repoRequests).toHaveLength(1);
    expect(out.project.pendingConversion).toMatchObject({
      toWorkflowKey: 'code',
      requests: [{ name: 'acme/fresh', status: 'pending' }],
    });
    expect((await project(res.id)).workflow_key).toBe('research');
    const [item] = (await deskOf('repo_create')).filter((i) => i.projectId === res.id);
    expect(item).toMatchObject({ kind: 'approval', title: 'Create repository acme/fresh' });
    expect(item.body).toContain('GitHub login');
    expect(
      (await q('SELECT requested_by_user_id, requested_by_agent_id FROM repo_requests'))[0],
    ).toMatchObject({
      requested_by_user_id: w.owner.id,
      requested_by_agent_id: null,
    });
    // a second conversion waits behind the first
    const second = await convert(res.id, { toWorkflowKey: 'support', repos: [] });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conversion_pending');
    // approve: the runner creates it
    const from = r.received.length;
    expect((await owner('POST', `/api/desk/${item.id}/resolve`, { resolution: 'approved' })).status).toBe(
      200,
    );
    const cmd = await runnerCommand(from);
    expect(cmd.payload).toMatchObject({ name: 'acme/fresh', visibility: 'private', projectKey: res.key });
    // still research until the repository exists
    expect((await project(res.id)).workflow_key).toBe('research');
    r.send('command.result', {
      commandId: cmd.commandId ?? cmd.id,
      ok: true,
      result: { ok: true, remoteUrl: 'https://github.com/acme/fresh.git', localPath: '/home/me/fresh' },
    });
    await until(async () => (await project(res.id)).workflow_key === 'code', 5000, 'converted');
    const p = await project(res.id);
    expect(p.pending_conversion).toBeNull();
    expect(
      (await q('SELECT name FROM project_repos WHERE project_id=$1 AND removed_at IS NULL', [res.id]))[0],
    ).toMatchObject({ name: 'fresh' });
    const ev = (await events('ProjectConverted', res.id))[0];
    expect(ev?.payload.repoIds).toHaveLength(1);
    expect(await status(rc.id)).toBe('queued');
    // the branch question for the new repository
    await w.t.app.ctx.notifier.flush();
    const asked = await until(
      async () =>
        (
          await q(
            `SELECT data FROM desk_items WHERE project_id=$1 AND subkind='working_branch' AND status='open'`,
            [res.id],
          )
        )[0],
      5000,
      'branch question',
    );
    expect(asked.data.reason).toBe('conversion');
  });

  it('a declined request cancels the conversion; the project stays in the research stage', async () => {
    const res = await newProject('research');
    await ok(
      convert(res.id, {
        toWorkflowKey: 'code',
        repos: [{ create: { name: 'acme/declined', visibility: 'public' } }],
      }),
    );
    const item = (await deskOf('repo_create')).find((i) => i.title === 'Create repository acme/declined');
    expect(
      (await owner('POST', `/api/desk/${item.id}/resolve`, { resolution: 'rejected', note: 'no' })).status,
    ).toBe(200);
    const p = await project(res.id);
    expect(p).toMatchObject({ workflow_key: 'research', pending_conversion: null });
    expect(await events('ProjectConversionCancelled', res.id)).toHaveLength(1);
    // the dialog can ask again
    expect(
      (
        await convert(res.id, {
          toWorkflowKey: 'code',
          repos: [{ create: { name: 'acme/declined', visibility: 'public' } }],
        })
      ).status,
    ).toBe(200);
  });

  it('the Owner can cancel a waiting conversion, which declines its requests', async () => {
    const res = await newProject('research');
    await ok(
      convert(res.id, {
        toWorkflowKey: 'code',
        repos: [{ create: { name: 'acme/cancelled', visibility: 'private' } }],
      }),
    );
    const out = await ok<any>(owner('DELETE', `/api/projects/${res.id}/convert`));
    expect(out.project.pendingConversion).toBeNull();
    expect((await q(`SELECT status FROM repo_requests WHERE name='acme/cancelled'`))[0]?.status).toBe(
      'rejected',
    );
    expect(
      (await deskOf('repo_create')).find((i) => i.title === 'Create repository acme/cancelled'),
    ).toBeUndefined();
    expect((await owner('DELETE', `/api/projects/${res.id}/convert`)).status).toBe(404);
  });

  it('converts at once when another repository exists; the new one is added when it is created', async () => {
    const res = await newProject('research');
    const out = await ok<any>(
      convert(res.id, {
        toWorkflowKey: 'code',
        repos: [
          { name: 'reload', remoteUrl: URL1 },
          { create: { name: 'acme/later', visibility: 'private' } },
        ],
      }),
    );
    expect(out.status).toBe('converted');
    expect(out.repoRequests).toHaveLength(1);
    const item = (await deskOf('repo_create')).find((i) => i.title === 'Create repository acme/later');
    const from = r.received.length;
    await ok(owner('POST', `/api/desk/${item.id}/resolve`, { resolution: 'approved' }));
    const cmd = await runnerCommand(from);
    r.send('command.result', {
      commandId: cmd.commandId ?? cmd.id,
      ok: true,
      result: { ok: true, remoteUrl: 'https://github.com/acme/later.git', localPath: '/home/me/later' },
    });
    await until(
      async () =>
        (await q('SELECT 1 FROM project_repos WHERE project_id=$1 AND removed_at IS NULL', [res.id]))
          .length === 2,
      5000,
      'second repository',
    );
    expect(await events('ProjectConverted', res.id)).toHaveLength(1);
  });

  it('archiving the project ends a waiting conversion', async () => {
    const res = await newProject('research');
    await ok(
      convert(res.id, {
        toWorkflowKey: 'code',
        repos: [{ create: { name: 'acme/archived', visibility: 'private' } }],
      }),
    );
    await ok(owner('POST', `/api/projects/${res.id}/archive`));
    expect((await project(res.id)).pending_conversion).toBeNull();
    expect((await q(`SELECT status FROM repo_requests WHERE name='acme/archived'`))[0]?.status).toBe(
      'rejected',
    );
  });
});
