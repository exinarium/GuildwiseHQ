import { randomUUID } from 'node:crypto';
import { SETUP_SCAN_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, type Member } from './helpers/members.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

// The v1a review fixes (docs/design/deploy-run-ux-design.md section 14): the scan fails closed, a project plan needs the
// consent of the owner of another member's computer, tests run only on your own computer, the server decides source and
// docker, every environment has its own compose project name, a failed test replay stops what it started.

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let w: World;
let r: FakeRunner;
let member: Member;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: ['runs:1', 'runs:2', SETUP_SCAN_CAPABILITY] });
  member = await addMember(w, 'dev');
  // the member's computer: online, new enough, holds the project code (no runner needed: commands queue)
  await q(`UPDATE workstations SET connected=true WHERE id=$1`, [member.workstationId]);
  await q(
    `INSERT INTO workstation_capabilities (workstation_id, capabilities, updated_at) VALUES ($1,$2::text[],now())
     ON CONFLICT (workstation_id) DO UPDATE SET capabilities=EXCLUDED.capabilities`,
    [member.workstationId, ['runs:1', 'runs:2', SETUP_SCAN_CAPABILITY]],
  );
  await q(
    `INSERT INTO workstation_repos (workstation_id, project_repo_id, local_path, reported_at) VALUES ($1,$2,'/tmp/m',now())
     ON CONFLICT DO NOTHING`,
    [member.workstationId, w.repoId],
  );
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
const commandsOf = (type: string, envId?: string) =>
  q(
    `SELECT * FROM runner_commands WHERE type=$1 ${envId ? `AND payload->>'envId'='${envId}'` : ''} ORDER BY created_at`,
    [type],
  );

const PLAN = (notes = 'plan', over: Record<string, unknown> = {}) => ({
  version: 1,
  repos: [{ repoId: w.repoId }],
  setup: [],
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
  call('PUT', planUrl(), { plan, scope: 'project', ...extra });

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
  await q(`DELETE FROM runner_commands WHERE type IN ('run.start','run.stop')`);
});

describe('who may do what with run steps', () => {
  it('the owner cannot save, test, drop or resolve things on another member computer (403)', async () => {
    const mine = await raw('PUT', planUrl(), {
      plan: PLAN(),
      scope: { workstationId: member.workstationId },
    });
    expect(mine.status).toBe(403);
    expect(
      (await raw('POST', `${planUrl()}/test`, { workstationId: member.workstationId, plan: PLAN() })).status,
    ).toBe(403);
    // a plan and a proposal that belong to the member's computer
    const planId = randomUUID();
    await q(
      `INSERT INTO run_plans (id, org_id, project_id, workstation_id, version, status, plan, fingerprint, created_at, source)
       SELECT $1, org_id, id, $3, 1, 'active', $4::jsonb, 'f', now(), 'devops' FROM projects WHERE id=$2`,
      [planId, w.projectId, member.workstationId, JSON.stringify(PLAN())],
    );
    expect((await raw('DELETE', `${planUrl()}/${planId}`)).status).toBe(403);
    const proposalId = randomUUID();
    await q(
      `INSERT INTO setup_proposals (id, org_id, project_id, area, request_id, workstation_id, proposal, status, submitted_at)
       SELECT $1, org_id, id, 'run', $4, $3, '{}'::jsonb, 'open', now() FROM projects WHERE id=$2`,
      [proposalId, w.projectId, member.workstationId, randomUUID()],
    );
    expect(
      (await raw('POST', `/api/setup-proposals/${proposalId}/resolve`, { outcome: 'dismissed' })).status,
    ).toBe(403);
    // the member (not a project owner) cannot do any of it either
    expect((await raw('PUT', planUrl(), { plan: PLAN() }, member.cookie)).status).toBe(403);
    expect((await raw('DELETE', `${planUrl()}/${planId}`, undefined, member.cookie)).status).toBe(403);
  });

  it('the server decides the source and docker, not the page', async () => {
    const sneaky = PLAN();
    sneaky.services[0]!.docker = true; // a web app cannot run outside the sandbox
    const out = await saveProject(sneaky, { source: 'scan' }); // the page says scan: ignored
    expect(out.projectPlan.source).toBe('owner');
    expect(out.projectPlan.plan.services[0].docker).toBe(false);
    const compose = PLAN();
    compose.services[0] = {
      ...compose.services[0]!,
      name: 'stack',
      template: 'compose_stack',
      cmd: ['docker', 'compose', '-p', 'aom-run-stack-${envId}', '-f', 'c.yml', 'up'],
      docker: false,
    } as any;
    const c = await saveProject(compose);
    expect(c.projectPlan.plan.services[0].docker).toBe(true);
  });

  it('refuses a settings file in a secret place and compose names that start with a dash', async () => {
    const bad = PLAN();
    (bad.services[0] as any).envFile = '/home/u/.ssh/config';
    const a = await raw('PUT', planUrl(), { plan: bad });
    expect(a.status).toBe(400);
    expect(a.body.error.message).toContain('.ssh');
    const dash = PLAN();
    dash.services[0] = {
      ...dash.services[0]!,
      template: 'compose_stack',
      cmd: ['docker', 'compose', '-f', 'c.yml', 'up', '--build'],
    } as any;
    expect((await raw('PUT', planUrl(), { plan: dash })).status).toBe(400);
  });

  it('only the project owner flips production or testing on a target', async () => {
    const base = `/api/projects/${w.projectId}/deploy-targets`;
    const t = await call('POST', base, { name: 'plain', kind: 'local_docker' }, 201);
    expect(
      (await raw('PATCH', `/api/deploy-targets/${t.id}`, { production: true }, member.cookie)).status,
    ).toBe(403);
    expect(
      (await raw('POST', base, { name: 'prod2', kind: 'local_docker', production: true }, member.cookie))
        .status,
    ).toBe(403);
    // an ordinary edit by a member is not touched by this rule
    expect(
      (await raw('PATCH', `/api/deploy-targets/${t.id}`, { notes: 'x' }, member.cookie)).status,
    ).not.toBe(403);
  });
});

describe('consent to run a project plan on another computer', () => {
  const startOn = (wsId: string) => raw('POST', '/api/runs', { projectId: w.projectId, workstationId: wsId });

  it('waits for "Allow on my computer" from the owner of that computer, per plan version', async () => {
    await saveProject(PLAN('v1'));
    // the owner (an org manager) starts the app on the member's computer: no consent yet
    const blocked = await startOn(member.workstationId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('plan_needs_consent');
    expect(await commandsOf('run.start')).toHaveLength(0);

    // the member sees what would run, in plain words
    const seen = await call('GET', planUrl(), undefined, 200, member.cookie);
    expect(seen.consents).toHaveLength(1);
    expect(seen.consents[0]).toMatchObject({
      workstationId: member.workstationId,
      steps: [{ kind: 'part', label: 'The website or app', command: 'npm run dev', docker: false }],
    });
    // the owner has the plan's author's computer: nothing to allow
    expect((await call('GET', planUrl())).consents).toEqual([]);

    const planId = seen.consents[0].planId;
    // nobody else can allow it
    const url = `${planUrl()}/${planId}/consent`;
    expect((await raw('POST', url, { workstationId: member.workstationId })).status).toBe(403);
    await call('POST', url, { workstationId: member.workstationId }, 200, member.cookie);
    expect((await call('GET', planUrl(), undefined, 200, member.cookie)).consents).toEqual([]);

    const ok1 = await startOn(member.workstationId);
    expect(ok1.status).toBe(201);
    const cmd = (await commandsOf('run.start', ok1.body.environment.id))[0];
    expect(cmd.payload.replay.plan.services[0].name).toBe('web');

    // a new version asks again
    await saveProject(PLAN('v2'));
    expect((await startOn(member.workstationId)).status).toBe(409);
    expect((await call('GET', planUrl(), undefined, 200, member.cookie)).consents).toHaveLength(1);
  });

  it('DevOps plans and the plans of the computer own user are unaffected', async () => {
    await call('PUT', planUrl(), { plan: PLAN('own'), scope: { workstationId: w.workstationId } });
    await saveProject(PLAN('owners'));
    const env = await raw('POST', '/api/runs', { projectId: w.projectId, workstationId: w.workstationId });
    expect(env.status).toBe(201);
    expect(env.body.environment.replayed).toBe(true);
  });

  it('the answer to a save names the version and the computers that keep their own steps', async () => {
    await call('PUT', planUrl(), { plan: PLAN('own'), scope: { workstationId: w.workstationId } });
    const out = await saveProject(PLAN('p'));
    expect(out.saved).toMatchObject({ scope: 'project', computersWithOwnSteps: [expect.any(String)] });
    const test = await raw('POST', `${planUrl()}/test`, { workstationId: w.workstationId, plan: PLAN('t') });
    expect(test.status).toBe(201);
    expect(test.body.ran).toEqual({ source: 'unsaved', version: null });
  });
});

describe('every environment has its own names', () => {
  it('fills ${envId} per environment so two test copies never share a compose project', async () => {
    const compose = PLAN();
    compose.services[0] = {
      ...compose.services[0]!,
      template: 'compose_stack',
      cmd: ['docker', 'compose', '-p', 'aom-run-stack-${envId}', '-f', 'c.yml', 'up'],
      stopCmd: ['docker', 'compose', '-p', 'aom-run-stack-${envId}', '-f', 'c.yml', 'down'],
    } as any;
    await saveProject(compose);
    const a = (
      await call('POST', '/api/runs', { projectId: w.projectId, workstationId: w.workstationId }, 201)
    ).environment;
    await q(`UPDATE run_environments SET state='stopped' WHERE id=$1`, [a.id]);
    const b = (
      await call('POST', '/api/runs', { projectId: w.projectId, workstationId: w.workstationId }, 201)
    ).environment;
    const names = [a.id, b.id].map(
      async (id) => (await commandsOf('run.start', id))[0].payload.replay.plan.services[0],
    );
    const [sa, sb] = (await Promise.all(names)) as any[];
    expect(sa.cmd[3]).toBe(`aom-run-stack-${a.id.replace(/-/g, '').slice(0, 8)}`);
    expect(sb.cmd[3]).toBe(`aom-run-stack-${b.id.replace(/-/g, '').slice(0, 8)}`);
    expect(sa.cmd[3]).not.toBe(sb.cmd[3]);
    expect(sa.stopCmd[3]).toBe(sa.cmd[3]);
  });
});

describe('failures', () => {
  it('a failed test replay stops what it started', async () => {
    const env = (
      await call('POST', `${planUrl()}/test`, { workstationId: w.workstationId, plan: PLAN() }, 201)
    ).environment;
    r.send('run.replay.failed', { envId: env.id, reason: 'npm exploded', logTail: '', stale: false });
    await r.barrier();
    expect((await q('SELECT state FROM run_environments WHERE id=$1', [env.id]))[0].state).toBe('failed');
    const stops = await commandsOf('run.stop', env.id);
    expect(stops).toHaveLength(1);
    expect(stops[0].payload.reason).toBe('failed');
  });

  it('the failure flagged on an owner plan is cleared when an environment that replayed it becomes healthy', async () => {
    await saveProject(PLAN('flagged'));
    const env = (
      await call('POST', '/api/runs', { projectId: w.projectId, workstationId: w.workstationId }, 201)
    ).environment;
    r.send('run.replay.failed', { envId: env.id, reason: 'port busy', logTail: '', stale: false });
    await r.barrier();
    const flagged = (
      await q(`SELECT last_failure FROM run_plans WHERE project_id=$1 AND status='active'`, [w.projectId])
    )[0];
    expect(flagged.last_failure.reason).toBe('port busy');
    await q(`UPDATE run_environments SET state='stopped' WHERE id=$1`, [env.id]);
    const again = (
      await call('POST', '/api/runs', { projectId: w.projectId, workstationId: w.workstationId }, 201)
    ).environment;
    r.send('run.status', { envId: again.id, state: 'healthy', services: [] });
    await r.barrier();
    await until(
      async () =>
        (
          await q(`SELECT last_failure FROM run_plans WHERE project_id=$1 AND status='active'`, [w.projectId])
        )[0].last_failure === null,
      5000,
      'cleared',
    );
  });
});

describe('a scan fails closed', () => {
  const scanReq = (area = 'run') => call('POST', `/api/projects/${w.projectId}/scan`, { area }, 202);

  it('the shift carries the scan kind, so the runner is read-only whatever the brief holds', async () => {
    const { requestId } = await scanReq();
    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    const s = (await r.waitFor('shift.start', (f: any) => f.kind === 'devops', 8000, from)) as any;
    expect(s.devops.scanKind).toBe('run_scan');
    expect(s.devops.scan).toBeTruthy();
    void requestId;
  });

  it('a scan whose brief cannot be built fails the request instead of running as an ordinary DevOps shift', async () => {
    const { requestId } = await scanReq();
    // the project row the brief reads is gone
    await q(
      `UPDATE devops_requests SET context = jsonb_set(context, '{projectId}', to_jsonb($2::text)) WHERE id=$1`,
      [requestId, randomUUID()],
    );
    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    await until(
      async () =>
        (await q('SELECT status FROM devops_requests WHERE id=$1', [requestId]))[0].status === 'failed',
      8000,
      'failed',
    );
    expect(
      r.received.slice(from).some((f: any) => f.type === 'shift.start' && f.payload?.kind === 'devops'),
    ).toBe(false);
  });

  it('the scan button explains why a computer cannot scan, with the same rule that refuses the start', async () => {
    await q('UPDATE workstations SET connected=false WHERE id=$1', [member.workstationId]);
    try {
      const o = await call('GET', planUrl(), undefined, 200, member.cookie);
      expect(o.workstations.find((x: any) => x.id === member.workstationId)).toMatchObject({
        canScan: false,
        scanBlocked: expect.stringContaining('offline'),
      });
    } finally {
      await q('UPDATE workstations SET connected=true WHERE id=$1', [member.workstationId]);
    }
    await q('UPDATE agents SET status=$2 WHERE workstation_id=$1 AND is_devops', [
      member.workstationId,
      'retired',
    ]);
    try {
      const o = await call('GET', planUrl(), undefined, 200, member.cookie);
      expect(o.workstations.find((x: any) => x.id === member.workstationId)).toMatchObject({
        canScan: false,
        scanBlocked: expect.stringContaining('no DevOps engineer'),
      });
    } finally {
      await q('UPDATE agents SET status=$2 WHERE workstation_id=$1 AND is_devops', [
        member.workstationId,
        'active',
      ]);
    }
  });
});
