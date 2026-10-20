import { randomUUID } from 'node:crypto';
import { SETUP_SCAN_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, type Member } from './helpers/members.ts';
import { createWorld, ok, pairWorkstation, until, type World } from './helpers/world.ts';

// Guided run steps and "Scan with DevOps" (docs/design/deploy-run-ux-design.md, v1a): the project-wide plan with its
// replay fallback, the owner's word winning over staleness, "Test these steps", the scan request, the proposal and its
// review, and local deploy targets that name a workstation. The runner here announces runs:1, runs:2 and setup-scan:1.

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let w: World;
let r: FakeRunner;
let member: Member;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: ['runs:1', 'runs:2', SETUP_SCAN_CAPABILITY] });
  member = await addMember(w, 'dev');
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200, cookie = w.owner.cookie) =>
  ok<any>(w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) }), status);
const raw = (method: string, url: string, body?: unknown, cookie = w.owner.cookie) =>
  w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) });
const planUrl = () => `/api/projects/${w.projectId}/run-plan`;
const start = (body: Record<string, unknown> = {}, status = 201) =>
  call('POST', '/api/runs', { projectId: w.projectId, workstationId: w.workstationId, ...body }, status);
const commandsOf = (type: string, envId?: string) =>
  q(
    `SELECT * FROM runner_commands WHERE type=$1 ${envId ? `AND payload->>'envId'='${envId}'` : ''} ORDER BY created_at`,
    [type],
  );
const status = async (envId: string, state: string, extra: Record<string, unknown> = {}) => {
  r.send('run.status', { envId, state, services: [], ...extra });
  await r.barrier();
};
const plans = () =>
  q('SELECT * FROM run_plans WHERE project_id=$1 ORDER BY created_at, version', [w.projectId]);
const live = async (wsId: string | null) =>
  (await plans()).find((p: any) => p.status !== 'superseded' && p.workstation_id === wsId);

const PLAN = (notes = 'plan', over: Record<string, unknown> = {}) => ({
  version: 1,
  repos: [{ repoId: w.repoId }],
  setup: [
    {
      name: 'Install packages',
      label: 'Install packages',
      template: 'install_packages',
      repoId: w.repoId,
      cwd: '.',
      cmd: ['npm', 'ci'],
      timeoutSec: 1200,
      when: 'changed:package-lock.json',
    },
  ],
  services: [
    {
      name: 'web',
      label: 'The website or app',
      template: 'web_app',
      repoId: w.repoId,
      cwd: '.',
      cmd: ['npm', 'run', 'dev'],
      env: {},
      ports: [{ name: 'http', default: 5173, envVar: 'PORT' }],
      health: { kind: 'none', graceSec: 3 },
      startTimeoutSec: 300,
      after: [],
      docker: false,
    },
  ],
  notes,
  ...over,
});
const saveProject = (plan: unknown = PLAN(), extra: Record<string, unknown> = {}) =>
  call('PUT', planUrl(), { plan, scope: 'project', source: 'owner', ...extra });

beforeEach(async () => {
  await q(
    `UPDATE run_environments SET state='stopped', stopped_at=now(), stop_reason='failed' WHERE state NOT IN ('stopped','failed')`,
  );
  await q(`UPDATE run_plans SET status='superseded' WHERE project_id=$1`, [w.projectId]);
  await q(`UPDATE setup_proposals SET status='superseded' WHERE project_id=$1 AND status='open'`, [
    w.projectId,
  ]);
  await q(`UPDATE devops_requests SET status='done' WHERE status IN ('queued','running','needs_approval')`);
  await q(`UPDATE shifts SET status='ended' WHERE kind='devops' AND status <> 'ended'`);
  await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
    w.workstationId,
    ['runs:1', 'runs:2', SETUP_SCAN_CAPABILITY],
  ]);
  await q(`DELETE FROM runner_commands WHERE type IN ('run.start')`);
  await call('PUT', `/api/projects/${w.projectId}/run-settings`, {
    runInstructions: '',
    repoInstructions: [],
    settings: { ttlHours: 8, allowDocker: false, services: [] },
  });
});

describe('the project-wide plan', () => {
  it('the owner saves it: an event, a version, source owner, no workstation', async () => {
    const out = await saveProject();
    expect(out.projectPlan).toMatchObject({
      workstationId: null,
      version: 1,
      status: 'active',
      source: 'owner',
      plan: { setup: [{ label: 'Install packages', template: 'install_packages' }] },
    });
    const ev = (await q(`SELECT payload FROM events WHERE type='RunPlanSaved' ORDER BY seq DESC LIMIT 1`))[0];
    expect(ev.payload).toMatchObject({ workstationId: null, source: 'owner', version: 1, requestId: null });
    expect(ev.payload.savedBy).toBeTruthy();
    // the next save is version 2 and supersedes the first
    const again = await saveProject(PLAN('second'));
    expect(again.projectPlan).toMatchObject({ version: 2, plan: { notes: 'second' } });
    expect((await plans()).filter((p: any) => p.status !== 'superseded')).toHaveLength(1);
  });

  it('a plan for one workstation needs a workstation of a project member', async () => {
    const stranger = await w.t.userSession(uniqueEmail('stranger-ws'));
    const other = await pairWorkstation(w.t, stranger, 'foreign');
    const bad = await raw('PUT', planUrl(), { plan: PLAN(), scope: { workstationId: other.workstationId } });
    expect(bad.status).toBe(404);
    const good = await call('PUT', planUrl(), {
      plan: PLAN('mine'),
      scope: { workstationId: w.workstationId },
    });
    expect(good.workstationPlans).toHaveLength(1);
    expect(good.workstationPlans[0]).toMatchObject({ workstationId: w.workstationId, source: 'owner' });
  });

  it('refuses a plan with problems, no running part, unknown repositories, and non-owners', async () => {
    const dup = PLAN();
    dup.services.push({ ...dup.services[0]!, name: 'WEB' });
    expect((await raw('PUT', planUrl(), { plan: dup })).status).toBe(400);
    expect((await raw('PUT', planUrl(), { plan: PLAN('x', { services: [] }) })).status).toBe(400);
    const foreign = PLAN();
    foreign.services[0]!.repoId = randomUUID();
    const bad = await raw('PUT', planUrl(), { plan: foreign });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('unknown_repo');
    expect((await raw('PUT', planUrl(), { plan: PLAN() }, member.cookie)).status).toBe(403);
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect((await raw('GET', planUrl(), undefined, stranger.cookie)).status).toBe(404);
  });

  it('the overview shows both plans, the workstations and what each can do', async () => {
    await saveProject();
    const o = await call('GET', planUrl());
    expect(o).toMatchObject({ canEdit: true, scan: null, proposal: null, lastStart: null });
    expect(o.repos).toEqual([{ repoId: w.repoId, name: 'toy' }]);
    expect(o.workstations).toEqual([
      expect.objectContaining({ id: w.workstationId, canRun: true, canScan: true, scanBlocked: null }),
    ]);
    const asMember = await call('GET', planUrl(), undefined, 200, member.cookie);
    expect(asMember.canEdit).toBe(false);
    expect(asMember.projectPlan).toMatchObject({ source: 'owner' });
  });

  it('a workstation without a plan of its own replays the project plan, ignoring BUILD.md', async () => {
    await saveProject();
    const env = (await start()).environment;
    expect(env).toMatchObject({ replayed: true, devopsRequestId: null });
    const cmd = (await commandsOf('run.start', env.id))[0];
    expect(cmd.payload.replay).toMatchObject({
      buildHash: null,
      plan: { services: [{ name: 'web' }], setup: [{ label: 'Install packages' }] },
    });
    const planned = await live(null);
    expect(cmd.payload.replay.planId).toBe(planned.id);
  });

  it('the workstation own plan wins over the project plan; once stale the project plan applies again', async () => {
    await saveProject(PLAN('project'));
    const first = (await start()).environment;
    // DevOps (a repair) saves a plan for this workstation
    r.send('run.plan.saved', { envId: first.id, plan: PLAN('repair'), buildHash: 'b1' });
    await r.barrier();
    await status(first.id, 'stopped', { endReason: 'stopped' });
    const own = await live(w.workstationId);
    expect(own).toMatchObject({ source: 'devops', status: 'active' });
    const second = (await start()).environment;
    expect((await commandsOf('run.start', second.id))[0].payload.replay).toMatchObject({
      planId: own.id,
      buildHash: 'b1',
      plan: { notes: 'repair' },
    });
    await status(second.id, 'stopped', { endReason: 'stopped' });
    // the settings change: the devops plan goes stale, the owner plan does not
    await call('PUT', `/api/projects/${w.projectId}/run-settings`, {
      runInstructions: 'something new',
      repoInstructions: [],
      settings: { ttlHours: 8, allowDocker: false, services: [] },
    });
    expect((await live(w.workstationId))?.status ?? 'stale').toBe('stale');
    const stale = (await plans()).find((p: any) => p.id === own.id);
    expect(stale.status).toBe('stale');
    expect((await live(null)).status).toBe('active');
    const third = (await start()).environment;
    expect((await commandsOf('run.start', third.id))[0].payload.replay).toMatchObject({
      plan: { notes: 'project' },
      buildHash: null,
    });
  });

  it('a run settings change never makes an owner plan stale', async () => {
    await saveProject();
    await call('PUT', `/api/projects/${w.projectId}/run-settings`, {
      runInstructions: 'changed',
      repoInstructions: [],
      settings: { ttlHours: 8, allowDocker: false, services: [] },
    });
    expect((await live(null)).status).toBe('active');
    const planId = (await live(null)).id;
    expect(
      await q(`SELECT 1 FROM events WHERE type='RunPlanMarkedStale' AND payload->>'planId'=$1`, [planId]),
    ).toHaveLength(0);
    // and a start still replays it
    expect((await start()).environment.replayed).toBe(true);
  });

  it('a runner without runs:2 goes through DevOps even when the owner saved a plan', async () => {
    await saveProject();
    await q(`UPDATE workstation_capabilities SET capabilities='{runs:1}' WHERE workstation_id=$1`, [
      w.workstationId,
    ]);
    const env = (await start()).environment;
    expect(env.replayed).toBe(false);
    expect(env.devopsRequestId).not.toBeNull();
  });

  it('a plan that does not cover the start (another repository) falls through to DevOps', async () => {
    const plan = PLAN();
    await saveProject(plan);
    // cover check: asking for a service the plan does not have
    const env = (await start({ services: ['api'] })).environment;
    expect(env.replayed).toBe(false);
  });
});

describe('a failed start from the owner plan', () => {
  it('keeps the plan active, flags the failure, and files the DevOps repair (which lands per workstation)', async () => {
    await saveProject();
    const env = (await start()).environment;
    r.send('run.replay.failed', {
      envId: env.id,
      reason: 'step "Install packages" failed (exit 1)',
      logTail: 'npm ERR! missing package-lock.json',
      stale: false,
    });
    await r.barrier();
    const plan = await live(null);
    expect(plan.status).toBe('active');
    expect(plan.last_failure).toMatchObject({ reason: 'step "Install packages" failed (exit 1)' });
    const requests = await q(`SELECT context FROM devops_requests WHERE context->>'envId'=$1`, [env.id]);
    expect(requests).toHaveLength(1);
    expect(requests[0].context.replayFailure).toContain('missing package-lock.json');
    const o = await call('GET', planUrl());
    expect(o.projectPlan.lastFailure.reason).toContain('Install packages');
    // DevOps fixes it: a plan of this workstation, shown as differing from the project version
    r.send('run.plan.saved', { envId: env.id, plan: PLAN('fixed'), buildHash: 'b2' });
    await r.barrier();
    const after = await call('GET', planUrl());
    expect(after.workstationPlans).toHaveLength(1);
    expect(after.workstationPlans[0]).toMatchObject({ source: 'devops', workstationId: w.workstationId });
    expect(after.projectPlan.status).toBe('active');
    // "Use the project version here"
    const gone = await call('DELETE', `${planUrl()}/${after.workstationPlans[0].id}`);
    expect(gone.workstationPlans).toHaveLength(0);
    expect(gone.projectPlan).not.toBeNull();
    // the project plan cannot be discarded this way
    expect((await raw('DELETE', `${planUrl()}/${gone.projectPlan.id}`)).status).toBe(404);
  });

  it('a BUILD.md change report (stale) does not mark an owner plan stale', async () => {
    await saveProject();
    const env = (await start()).environment;
    r.send('run.replay.failed', { envId: env.id, reason: 'BUILD.md has changed', logTail: '', stale: true });
    await r.barrier();
    expect((await live(null)).status).toBe('active');
  });
});

describe('Test these steps', () => {
  it('replays an unsaved plan on the chosen workstation: no DevOps request, no saved plan', async () => {
    const out = await call(
      'POST',
      `${planUrl()}/test`,
      { workstationId: w.workstationId, plan: PLAN('draft') },
      201,
    );
    expect(out.environment).toMatchObject({ replayed: true, devopsRequestId: null });
    const cmd = (await commandsOf('run.start', out.environment.id))[0];
    expect(cmd.payload.replay).toMatchObject({ buildHash: null, plan: { notes: 'draft' } });
    expect(await live(null)).toBeUndefined();
    expect(await live(w.workstationId)).toBeUndefined();
    // the start did not work: the environment ends failed with the reason, and DevOps is not asked to repair a draft
    const requestsBefore = (await q('SELECT count(*)::int AS n FROM devops_requests'))[0].n;
    r.send('run.replay.failed', {
      envId: out.environment.id,
      reason: 'step "Install packages" failed (exit 1)',
      logTail: 'boom',
      stale: false,
    });
    await r.barrier();
    const row = (await q('SELECT * FROM run_environments WHERE id=$1', [out.environment.id]))[0];
    expect(row).toMatchObject({ state: 'failed' });
    expect(row.last_error).toContain('Install packages');
    expect((await q('SELECT count(*)::int AS n FROM devops_requests'))[0].n).toBe(requestsBefore);
    const o = await call('GET', planUrl());
    expect(o.lastStart).toMatchObject({
      state: 'failed',
      failure: expect.stringContaining('Install packages'),
    });
  });

  it('without a plan in the request it tests the saved one; with none saved it says so; needs runs:2 and the owner', async () => {
    expect((await raw('POST', `${planUrl()}/test`, { workstationId: w.workstationId })).status).toBe(409);
    await saveProject(PLAN('saved'));
    const out = await call('POST', `${planUrl()}/test`, { workstationId: w.workstationId }, 201);
    expect((await commandsOf('run.start', out.environment.id))[0].payload.replay.plan.notes).toBe('saved');
    await q(`UPDATE run_environments SET state='stopped' WHERE id=$1`, [out.environment.id]);
    await q(`UPDATE workstation_capabilities SET capabilities='{runs:1}' WHERE workstation_id=$1`, [
      w.workstationId,
    ]);
    const old = await raw('POST', `${planUrl()}/test`, { workstationId: w.workstationId, plan: PLAN() });
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('runs_not_supported');
    expect(
      (
        await raw(
          'POST',
          `${planUrl()}/test`,
          { workstationId: w.workstationId, plan: PLAN() },
          member.cookie,
        )
      ).status,
    ).toBe(403);
  });
});

describe('Scan with DevOps', () => {
  const scan = (body: Record<string, unknown> = {}, status = 202) =>
    call('POST', `/api/projects/${w.projectId}/scan`, { area: 'run', ...body }, status);

  async function devopsShift(requestId: string) {
    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    const s = (await r.waitFor('shift.start', (f: any) => f.kind === 'devops', 8000, from)) as any;
    r.accepted(s.shiftId);
    r.started(s.shiftId);
    await until(
      async () =>
        (await q(`SELECT status FROM devops_requests WHERE id=$1`, [requestId]))[0]!.status === 'running',
      5000,
      'running',
    );
    return s;
  }
  async function rpc(shiftId: string, method: string, params: Record<string, unknown>) {
    const rpcId = randomUUID();
    const from = r.received.length;
    r.send('rpc.request', { rpcId, shiftId, method, params });
    return (await r.waitFor('rpc.response', (f: any) => f.rpcId === rpcId, 8000, from)) as any;
  }
  const PROPOSAL = () => ({
    area: 'run',
    run: PLAN('read from package.json'),
    items: [
      { path: '/setup/0', confidence: 'found', evidence: [{ file: 'package.json', line: 7 }] },
      { path: '/services/0/ports/0/default', confidence: 'guessed', note: 'the usual vite port' },
      { path: '/services/0/health', confidence: 'unknown' },
    ],
    questions: [
      { path: '/services/0/health', question: 'Which page shows that the app is ready?', default: '/' },
    ],
    secretsNeeded: [],
    notes: 'Looks like a Vite app.',
  });

  it('files one read-only DevOps request on a workstation with the project code, and a second press shows the running one', async () => {
    const a = await scan({ note: 'the website is in web/' });
    const b = await scan();
    expect(b.requestId).toBe(a.requestId);
    const req = (await q('SELECT * FROM devops_requests WHERE id=$1', [a.requestId]))[0];
    expect(req).toMatchObject({ workstation_id: w.workstationId, status: 'queued' });
    expect(req.context).toMatchObject({
      requestKind: 'run_scan',
      scanArea: 'run',
      projectId: w.projectId,
      scanNote: 'the website is in web/',
    });
    const o = await call('GET', planUrl());
    expect(o.scan).toMatchObject({
      requestId: a.requestId,
      area: 'run',
      status: 'queued',
      workstationName: expect.any(String),
    });
    // the brief the shift gets: a scan section, no run section
    const s = await devopsShift(a.requestId);
    expect(s.devops.scan).toMatchObject({
      area: 'run',
      projectKey: 'TOY',
      repos: [{ repoId: w.repoId, name: 'toy' }],
    });
    expect(s.devops.run).toBeUndefined();
    expect(s.devops.summary).toContain('Scan');
  });

  it('is refused on an old runner, an offline workstation, a stranger workstation and for non-owners; deploy scans are not available yet', async () => {
    await q(`UPDATE workstation_capabilities SET capabilities='{runs:1,runs:2}' WHERE workstation_id=$1`, [
      w.workstationId,
    ]);
    const old = await raw('POST', `/api/projects/${w.projectId}/scan`, { area: 'run' });
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('scan_not_supported');
    const o = await call('GET', planUrl());
    expect(o.workstations[0]).toMatchObject({
      canScan: false,
      scanBlocked: expect.stringContaining('too old'),
    });
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      w.workstationId,
      ['runs:1', 'runs:2', SETUP_SCAN_CAPABILITY],
    ]);
    expect(
      (await raw('POST', `/api/projects/${w.projectId}/scan`, { area: 'run' }, member.cookie)).status,
    ).toBe(403);
    expect((await raw('POST', `/api/projects/${w.projectId}/scan`, { area: 'deploy' })).status).toBe(400);
    expect(
      (
        await raw('POST', `/api/projects/${w.projectId}/scan`, {
          area: 'run',
          workstationId: member.workstationId,
        })
      ).status,
    ).toBe(409);
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    try {
      const off = await raw('POST', `/api/projects/${w.projectId}/scan`, { area: 'run' });
      expect(off.status).toBe(409);
      expect(off.body.error.code).toBe('workstation_offline');
    } finally {
      await q(`UPDATE workstations SET connected=true WHERE id=$1`, [w.workstationId]);
    }
  });

  it('setup.propose: a bad proposal is refused with the reason; a good one is stored and the open one is replaced', async () => {
    const { requestId } = await scan();
    const s = await devopsShift(requestId);
    const bad = await rpc(s.shiftId, 'setup.propose', {
      proposal: { area: 'run', run: PLAN(), items: [{ path: '/services/9', confidence: 'found' }] },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('/services/9');
    const wrongArea = await rpc(s.shiftId, 'setup.propose', { proposal: { area: 'deploy', deploy: {} } });
    expect(wrongArea.error).toContain('run scan');
    const foreign = PLAN();
    foreign.services[0]!.repoId = randomUUID();
    const unknownRepo = await rpc(s.shiftId, 'setup.propose', { proposal: { area: 'run', run: foreign } });
    expect(unknownRepo.error).toContain('not a repository of this project');
    const cyc = PLAN();
    (cyc.services[0] as { after: string[] }).after = ['web'];
    expect((await rpc(s.shiftId, 'setup.propose', { proposal: { area: 'run', run: cyc } })).error).toContain(
      'invalid run plan',
    );
    expect(await q('SELECT 1 FROM setup_proposals')).toHaveLength(0);

    const good = await rpc(s.shiftId, 'setup.propose', { proposal: PROPOSAL() });
    expect(good.ok).toBe(true);
    const rows = await q('SELECT * FROM setup_proposals WHERE project_id=$1', [w.projectId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'open',
      area: 'run',
      request_id: requestId,
      workstation_id: w.workstationId,
    });
    const o = await call('GET', planUrl());
    expect(o.scan).not.toBeNull(); // the request is still running
    expect(o.proposal).toMatchObject({
      id: rows[0].id,
      area: 'run',
      status: 'open',
      proposal: { notes: 'Looks like a Vite app.', questions: [{ default: '/' }] },
    });
    // a second submission in the same shift replaces the first
    await rpc(s.shiftId, 'setup.propose', { proposal: { ...PROPOSAL(), notes: 'second try' } });
    const both = await q('SELECT status, proposal FROM setup_proposals ORDER BY submitted_at');
    expect(both.map((x: any) => x.status)).toEqual(['superseded', 'open']);
    expect((await call('GET', planUrl())).proposal.proposal.notes).toBe('second try');
  });

  it('only a scan request of the DevOps engineer may propose', async () => {
    const wrong = await rpc(randomUUID(), 'setup.propose', { proposal: PROPOSAL() });
    expect(wrong.ok).toBe(false);
  });

  it('confirming the proposal saves the project plan as a scan plan and resolves it; dismissing keeps the plan unchanged', async () => {
    const { requestId } = await scan();
    const s = await devopsShift(requestId);
    await rpc(s.shiftId, 'setup.propose', { proposal: PROPOSAL() });
    const pid = (await q('SELECT id FROM setup_proposals WHERE status=$1', ['open']))[0].id;
    // answered question: the user chose a health path, so the saved plan differs from the proposal
    const edited = PROPOSAL().run;
    edited.services[0]!.health = {
      kind: 'http',
      url: 'http://localhost:${port}/health',
      expect: '2xx',
    } as never;
    const out = await call('PUT', planUrl(), {
      plan: edited,
      scope: 'project',
      source: 'scan',
      proposalId: pid,
    });
    expect(out.projectPlan).toMatchObject({
      source: 'scan',
      plan: { services: [{ health: { kind: 'http' } }] },
    });
    expect((await q('SELECT status FROM setup_proposals WHERE id=$1', [pid]))[0].status).toBe('accepted');
    expect((await live(null)).proposal_id).toBe(pid);
    expect((await call('GET', planUrl())).proposal).toBeNull();
    // used proposals cannot be used again
    const again = await raw('PUT', planUrl(), {
      plan: edited,
      scope: 'project',
      source: 'scan',
      proposalId: pid,
    });
    expect(again.status).toBe(409);

    // dismiss
    await rpc(s.shiftId, 'setup.propose', { proposal: PROPOSAL() });
    const p2 = (await q('SELECT id FROM setup_proposals WHERE status=$1', ['open']))[0].id;
    expect(
      (await raw('POST', `/api/setup-proposals/${p2}/resolve`, { outcome: 'dismissed' }, member.cookie))
        .status,
    ).toBe(403);
    await call('POST', `/api/setup-proposals/${p2}/resolve`, { outcome: 'dismissed' });
    expect((await q('SELECT status FROM setup_proposals WHERE id=$1', [p2]))[0].status).toBe('dismissed');
    expect((await live(null)).id).toBe(out.projectPlan.id);
    expect(
      (await call('GET', `/api/projects/${w.projectId}/proposals?area=run`)).proposals.map(
        (x: any) => x.status,
      ),
    ).toContain('dismissed');
    expect((await raw('POST', `/api/setup-proposals/${p2}/resolve`, { outcome: 'accepted' })).status).toBe(
      400,
    );
  });

  it('a scan that ended without a proposal shows why', async () => {
    const { requestId } = await scan();
    await q(
      `UPDATE devops_requests SET status='failed', result_summary='the repository is empty' WHERE id=$1`,
      [requestId],
    );
    const o = await call('GET', planUrl());
    expect(o.scan).toBeNull();
    expect(o.scanProblem).toContain('the repository is empty');
    // and a new scan can start
    const next = await scan();
    expect(next.requestId).not.toBe(requestId);
  });

  it('a scan nobody answers is not "open" after 45 minutes', async () => {
    const { requestId } = await scan();
    await q(`UPDATE devops_requests SET created_at = now() - interval '50 minutes' WHERE id=$1`, [requestId]);
    expect((await call('GET', planUrl())).scan).toBeNull();
    expect((await scan()).requestId).not.toBe(requestId);
  });
});

describe('replay safety', () => {
  it('a full projection rebuild gives the same plans and proposals', async () => {
    await saveProject(PLAN('v1'));
    await saveProject(PLAN('v2'));
    const env = (await start()).environment;
    r.send('run.plan.saved', { envId: env.id, plan: PLAN('own'), buildHash: 'b' });
    await r.barrier();
    r.send('run.replay.failed', { envId: env.id, reason: 'x', logTail: '', stale: false });
    await r.barrier();
    const { requestId } = await call('POST', `/api/projects/${w.projectId}/scan`, { area: 'run' }, 202);
    void requestId;
    const snap = async () => ({
      plans: await q(
        `SELECT id, workstation_id, version, status, source, saved_by, proposal_id, last_failure, plan FROM run_plans WHERE project_id=$1 ORDER BY id`,
        [w.projectId],
      ),
      proposals: await q(`SELECT id, status, area, request_id, proposal FROM setup_proposals ORDER BY id`),
    });
    const before = await snap();
    expect(before.plans.length).toBeGreaterThan(2);
    await w.t.app.ctx.notifier.flush();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
  });
});

describe('local deploy targets on a workstation ("on this computer")', () => {
  it('a local Docker target may name a workstation of a member; the host stays refused', async () => {
    const base = `/api/projects/${w.projectId}/deploy-targets`;
    const t = await call(
      'POST',
      base,
      { name: 'office', kind: 'local_docker', workstationId: w.workstationId, production: false },
      201,
    );
    expect(t).toMatchObject({ kind: 'local_docker', workstationId: w.workstationId, production: false });
    expect(t.workstationName).toBeTruthy();
    expect((await raw('POST', base, { name: 'bad', kind: 'local_docker', host: 'x' })).status).toBe(422);
    const flipped = await call('PATCH', `/api/deploy-targets/${t.id}`, { production: true });
    expect(flipped.production).toBe(true);
    // still on that workstation after an edit
    const list = await call('GET', base);
    expect(list.targets.find((x: any) => x.id === t.id)).toMatchObject({
      workstationId: w.workstationId,
      production: true,
    });
    await call('DELETE', `/api/deploy-targets/${t.id}`, undefined, 204).catch(() => {});
  });
});
