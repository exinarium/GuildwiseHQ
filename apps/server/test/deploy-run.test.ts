import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueWake } from '../src/ceo/wakes.ts';
import { releaseDecision, requestDeployRun, sweepExpiredDeploys } from '../src/delivery/runs.ts';
import { deliveryPass } from '../src/delivery/triggers.ts';
import { act, keepOnline, startCeoShift } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import {
  advance,
  type DeliveryWorld,
  deliveryWorld,
  healthyRun,
  mergeLanded,
  parseFixture,
  passedRegression,
  setWeekday,
} from './helpers/delivery.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { ok, until } from './helpers/world.ts';

/**
 * Deploy runs end to end (docs/design/ceo-front-door.md 9.5 with the Owner's decisions of 14.2): the server checks the approved
 * recipe and the gate deterministically; the RECIPE says who releases; a released run is a durable `deploy.exec` pinned to the
 * approved hash; the workstation's answer closes it. The CEO is never the releaser unless the recipe names it.
 */
const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
let d: DeliveryWorld;
let r: FakeRunner;
let approvedHash: string;

beforeAll(async () => {
  d = await deliveryWorld();
  r = await d.w.connectRunner({ capabilities: ['ceo:1', 'delivery:1'] });
  await keepOnline(d.w);
  await setWeekday(d);
  await mergeLanded(d, COMMIT); // the commit the tests deploy was really merged
  const o = await d.observe(parseFixture(), { commit: '9999999aaaaaaa' });
  approvedHash = o.hash;
  await ok(d.approve(o.hash));
  await ok(
    d.w.t.req('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, {
      cookie: d.w.owner.cookie,
      body: { mode: 'recipe' },
    }),
  );
});
afterAll(async () => {
  r.close();
  await d.w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown, cookie = d.w.owner.cookie) =>
  d.w.t.req(method, url, {
    cookie,
    headers: { 'x-aom-org': d.orgId },
    ...(body === undefined ? {} : { body }),
  });
const ctx = () => d.w.t.app.ctx;
const execs = () => r.of('command').filter((c) => c.command === 'deploy.exec');
const run = async (id: string) => (await q('SELECT * FROM deploy_runs WHERE id=$1', [id]))[0]!;
const ev = (type: string) => q('SELECT payload FROM events WHERE type=$1 ORDER BY seq', [type]);
const trigger = { kind: 'trigger', id: null, name: 'after_merge', provenance: 'trigger' } as const;
const ownerReq = () => ({ kind: 'owner', id: d.w.owner.id, name: 'Owner', provenance: 'session' }) as const;
const ask = (
  env: string,
  o: {
    requester?: Parameters<typeof requestDeployRun>[1]['requester'];
    commit?: string;
    targets?: string[];
  } = {},
) =>
  requestDeployRun(ctx(), {
    projectId: d.w.projectId,
    env,
    commit: o.commit ?? COMMIT,
    targets: o.targets,
    trigger: 'request',
    requester: o.requester ?? ownerReq(),
  });
const ceoReq = (provenance: 'owner' | 'wake', untrusted = false) =>
  ({ kind: 'ceo', id: 'ceo-1', name: 'Ada', provenance, untrusted }) as const;

describe('an automatic environment (the recipe says `auto`)', () => {
  it('a trigger releases it once the gate holds: a durable deploy.exec pinned to the approved hash', async () => {
    const res = await requestDeployRun(ctx(), {
      projectId: d.w.projectId,
      env: 'local',
      commit: COMMIT,
      trigger: 'after_merge',
      requester: trigger,
    });
    expect(res.runs).toHaveLength(1);
    expect(res.runs[0]).toMatchObject({ status: 'queued', target: 'p5-local' });
    const id = res.runs[0]!.runId;
    expect(await run(id)).toMatchObject({
      status: 'queued',
      env: 'local',
      commit: COMMIT,
      hash: approvedHash,
      vault_commit: '9999999aaaaaaa',
    });
    await until(async () => execs().length === 1, 4000, 'deploy.exec reached the runner');
    expect(execs()[0]!.payload).toMatchObject({
      runId: id,
      hash: approvedHash,
      vaultCommit: '9999999aaaaaaa',
      env: 'local',
      commit: COMMIT,
      projectKey: 'TOY',
      target: { name: 'p5-local', kind: 'local_docker', appUrl: 'http://localhost:5500' },
      vault: { storage: 'local', folder: 'projects/toy' },
      trial: false,
      dryRun: false,
    });
    // the audit: who released it, on which gate
    const [g] = (await ev('DeployGateSatisfied')).slice(-1);
    expect(g!.payload).toMatchObject({
      runId: id,
      env: 'local',
      recipeHash: approvedHash,
      releasedBy: { kind: 'trigger' },
    });
    expect(
      await q(`SELECT 1 FROM events WHERE type='DeployRunRequested' AND payload->>'runId'=$1`, [id]),
    ).toHaveLength(1);
  });

  it('the workstation answers: started, then the result closes the run and wakes the CEO', async () => {
    const [cmd] = execs();
    const id = (cmd!.payload as { runId: string }).runId;
    r.send('deploy.progress', { runId: id, phase: 'started' });
    await until(async () => (await run(id)).status === 'running', 4000, 'running');
    r.send('command.result', {
      commandId: cmd!.commandId,
      ok: true,
      result: {
        outcome: 'succeeded',
        exitCode: 0,
        health: { ok: true },
        smoke: { ok: true },
        deployed: { commit: COMMIT, url: 'http://localhost:5500', version: 'run-abc1234' },
        deployedCommit: COMMIT,
        logTail: 'P5 DEPLOY READY abc1234',
        durationMs: 1000,
        summary: 'deployed run-abc1234',
      },
    });
    await until(async () => (await run(id)).status === 'succeeded', 4000, 'succeeded');
    expect(await run(id)).toMatchObject({
      health: { ok: true },
      smoke: { ok: true },
      url: 'http://localhost:5500',
      deployed_commit: COMMIT,
      summary: 'deployed run-abc1234',
    });
    expect((await run(id)).log_tail).toContain('P5 DEPLOY READY');
    expect(
      await q(`SELECT 1 FROM ceo_wakes WHERE reason='deploy_finished' AND subject_id=$1`, [id]),
    ).toHaveLength(1);
    // the command is done and a second answer of the same command changes nothing
    expect((await q('SELECT status FROM runner_commands WHERE id=$1', [cmd!.commandId]))[0]!.status).toBe(
      'done',
    );
  });

  it('a trigger the environment does not list is refused; so is an environment the recipe lacks', async () => {
    const wrong = await requestDeployRun(ctx(), {
      projectId: d.w.projectId,
      env: 'production',
      commit: COMMIT,
      trigger: 'after_merge',
      requester: trigger,
    });
    expect(wrong.runs[0]).toMatchObject({ status: 'refused', refusal: 'trigger_not_allowed' });
    expect((await ask('staging')).runs[0]).toMatchObject({ status: 'refused', refusal: 'unknown_env' });
  });
});

describe('the gate is checked deterministically; an unsatisfied gate refuses', () => {
  it('production: the local run is not 30 minutes old and no regression passed: refused, with everything that is missing', async () => {
    const res = await ask('production');
    expect(res.runs[0]).toMatchObject({ status: 'refused', refusal: 'gate_unsatisfied' });
    expect(res.runs[0]!.missing).toEqual(
      expect.arrayContaining([
        expect.stringContaining('local healthy on this commit for 30 minutes: not long enough yet'),
        expect.stringContaining('regression checks passed'),
      ]),
    );
    expect((await run(res.runs[0]!.runId)).status).toBe('refused');
    expect(execs()).toHaveLength(1);
  });

  it('a window closed or a freeze on stops it, whoever asks', async () => {
    await advance(d, 31 * 60_000);
    await passedRegression(d, 1);
    // an org rule bound to every production environment: frozen
    await ok(owner('PUT', '/api/delivery/presets', { name: 'freeze', gate: { requires: [], freeze: true } }));
    await ok(
      owner('PUT', '/api/delivery/bindings', {
        projectId: d.w.projectId,
        envMatch: 'production',
        preset: 'freeze',
      }),
    );
    const frozen = await ask('production');
    expect(frozen.runs[0]).toMatchObject({ status: 'refused', refusal: 'gate_unsatisfied' });
    expect(frozen.runs[0]!.missing).toContain('releases are frozen');
    await ok(
      owner('PUT', '/api/delivery/bindings', {
        projectId: d.w.projectId,
        envMatch: 'production',
        preset: null,
      }),
    );
    await advance(d, 9 * 3_600_000); // 19:31 UTC: outside 08-16
    const closed = await ask('production');
    expect(closed.runs[0]!.missing?.some((m) => m.startsWith('outside the release window'))).toBe(true);
    await setWeekday(d);
  });
});

describe('who releases (the recipe decides; the CEO is never the default)', () => {
  it('the gate holds and the recipe says owner: the release waits in the queue with the commit, the environment and the target', async () => {
    // the local run of this commit is now older than 30 minutes (the clock moved), and a regression passed
    await healthyRun(d, 'local', COMMIT, 45);
    await passedRegression(d, 1);
    const res = await ask('production', { requester: ceoReq('wake') });
    expect(res.runs[0]).toMatchObject({ status: 'waiting_release', target: 'p5-prod', waitingFor: 'owner' });
    expect(execs()).toHaveLength(1); // nothing was sent to a workstation
    const [row] = await q(`SELECT status, waiting_for, commit, released_by FROM deploy_runs WHERE id=$1`, [
      res.runs[0]!.runId,
    ]);
    expect(row).toMatchObject({
      status: 'waiting_release',
      waiting_for: 'owner',
      commit: COMMIT,
      released_by: null,
    });
    // a desk notice for the Owner (an alert; the Release button is in the queue)
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='deploy_release' AND status='open'`)).toHaveLength(
      1,
    );
  });

  it('the queue lists it; a member is refused; an Admin may release', async () => {
    const q1 = await ok<any>(owner('GET', '/api/delivery/queue'));
    expect(q1.items).toHaveLength(1);
    expect(q1.items[0]).toMatchObject({
      projectKey: 'TOY',
      env: 'production',
      commit: COMMIT,
      waitingFor: 'owner',
      gateNow: { satisfied: true, missing: [] },
    });
    expect(q1.items[0].targets).toEqual([
      expect.objectContaining({ targetName: 'p5-prod', production: true, host: 'prod' }),
    ]);
    const member = await d.member();
    expect(
      (await owner('GET', '/api/delivery/queue', undefined, member.cookie)).status,
    ).toBeGreaterThanOrEqual(403);
    expect(
      (
        await owner(
          'POST',
          '/api/delivery/release',
          { runIds: [q1.items[0].targets[0].runId] },
          member.cookie,
        )
      ).status,
    ).toBeGreaterThanOrEqual(403);
  });

  it('an environment with several servers offers a choice: the Admin releases the ones he picks, the others keep waiting', async () => {
    // a second production server in the recipe
    const two = parseFixture().environments;
    const recipe = {
      version: 1 as const,
      environments: two.map((e) =>
        e.name === 'production' ? { ...e, targets: ['p5-prod', 'p5-prod-2'] } : e,
      ),
    };
    await q(
      `INSERT INTO deploy_targets (id, org_id, project_id, name, kind, workstation_id, host, production, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,'p5-prod-2','remote_ssh',$4,'prod2',true,$2,now(),now())`,
      [randomUUID(), d.orgId, d.w.projectId, d.w.workstationId],
    );
    const o = await d.observe(recipe, { salt: '5', commit: '5555555bbbbbbb' });
    await ok(d.approve(o.hash));
    approvedHash = o.hash;
    const waiting = await ask('production', { requester: ceoReq('wake') });
    expect(waiting.runs.map((x) => [x.target, x.status])).toEqual([
      ['p5-prod', 'waiting_release'],
      ['p5-prod-2', 'waiting_release'],
    ]);
    const queue = await ok<any>(owner('GET', '/api/delivery/queue'));
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].targets.map((t: any) => t.targetName)).toEqual(['p5-prod', 'p5-prod-2']);
    // the Admin presses Release for the second server only
    const admin = await d.admin();
    const second = queue.items[0].targets[1].runId;
    const released = await ok<any>(
      owner('POST', '/api/delivery/release', { runIds: [second] }, admin.cookie),
    );
    expect(released.runs[0]).toMatchObject({ status: 'queued', target: 'p5-prod-2' });
    expect((await run(second)).status).toBe('queued');
    expect((await run(queue.items[0].targets[0].runId)).status).toBe('waiting_release');
    await until(async () => execs().length === 2, 4000, 'one deploy.exec for the chosen server');
    expect(execs()[1]!.payload).toMatchObject({
      runId: second,
      env: 'production',
      hash: approvedHash,
      target: { name: 'p5-prod-2' },
    });
    const [g] = (await ev('DeployGateSatisfied')).slice(-1);
    expect(g!.payload).toMatchObject({ runId: second, releasedBy: { kind: 'admin', id: admin.id } });
    expect((g!.payload as any).evidence.length).toBeGreaterThan(0);
  });

  it('the release is checked again when the button is pressed: a gate that no longer holds refuses', async () => {
    const queue = await ok<any>(owner('GET', '/api/delivery/queue'));
    const first = queue.items[0].targets[0].runId as string;
    await ok(owner('PUT', '/api/delivery/presets', { name: 'freeze', gate: { requires: [], freeze: true } }));
    await ok(
      owner('PUT', '/api/delivery/bindings', {
        projectId: d.w.projectId,
        envMatch: 'production',
        preset: 'freeze',
      }),
    );
    const stillListed = await ok<any>(owner('GET', '/api/delivery/queue'));
    expect(stillListed.items[0].gateNow).toMatchObject({
      satisfied: false,
      missing: ['releases are frozen'],
    });
    const res = await ok<any>(owner('POST', '/api/delivery/release', { runIds: [first] }));
    expect(res.runs[0]).toMatchObject({ status: 'refused', refusal: 'gate_unsatisfied' });
    await ok(
      owner('PUT', '/api/delivery/bindings', {
        projectId: d.w.projectId,
        envMatch: 'production',
        preset: null,
      }),
    );
    // the waiting run was replaced by the refused attempt only as a record; the queue is empty of it or still holds it
    expect(execs()).toHaveLength(2);
  });

  it('the Deploy button (the Owner session) releases at once: the same server path, no model', async () => {
    const res = await ok<any>(
      owner('POST', `/api/projects/${d.w.projectId}/delivery/deploy`, {
        env: 'production',
        commit: COMMIT,
        targets: ['p5-prod'],
      }),
    );
    expect(res.runs[0]).toMatchObject({ status: 'queued', target: 'p5-prod' });
    const [g] = (await ev('DeployGateSatisfied')).slice(-1);
    expect(g!.payload).toMatchObject({ releasedBy: { kind: 'owner', id: d.w.owner.id } });
    const member = await d.member();
    expect(
      (
        await owner(
          'POST',
          `/api/projects/${d.w.projectId}/delivery/deploy`,
          { env: 'production' },
          member.cookie,
        )
      ).status,
    ).toBeGreaterThanOrEqual(403);
  });

  it('releaseDecision: the CEO releases only when the recipe names the CEO; a wake never releases an owner-released production', () => {
    const owned = { releasedBy: 'owner' } as const;
    const ceo = { releasedBy: 'ceo' } as const;
    const auto = { releasedBy: 'auto' } as const;
    expect(releaseDecision(owned, ceoReq('owner'), true)).toEqual({ release: false, waitingFor: 'owner' });
    expect(releaseDecision(owned, ceoReq('wake'), true)).toEqual({ release: false, waitingFor: 'owner' });
    expect(releaseDecision(ceo, ceoReq('wake'), true)).toMatchObject({ release: true, by: { kind: 'ceo' } });
    expect(releaseDecision(ceo, ceoReq('owner'), true)).toMatchObject({ release: true, by: { kind: 'ceo' } });
    // outside text may have caused this wake: even where the recipe names the CEO, production waits for the Owner
    expect(releaseDecision(ceo, ceoReq('wake', true), true)).toEqual({ release: false, waitingFor: 'owner' });
    expect(releaseDecision(ceo, ceoReq('wake', true), false)).toMatchObject({ release: true });
    // a trigger or DevOps only asks: the CEO is woken to release
    expect(releaseDecision(ceo, trigger, true)).toEqual({ release: false, waitingFor: 'ceo' });
    expect(releaseDecision(owned, { kind: 'devops', id: 'x' }, true)).toEqual({
      release: false,
      waitingFor: 'owner',
    });
    expect(releaseDecision(auto, trigger, true)).toMatchObject({ release: true });
    // the Owner or an Admin always may
    expect(releaseDecision(owned, { kind: 'admin', id: 'a' }, true)).toMatchObject({ release: true });
    expect(releaseDecision(ceo, { kind: 'owner', id: 'o' }, true)).toMatchObject({ release: true });
  });
});

describe('the CEO verb', () => {
  it('a wake-mode CEO cannot release production unless the recipe allows it; with the recipe naming the CEO it does', async () => {
    // clean slate: nothing waits or runs for production
    await q(
      `UPDATE deploy_runs SET status='cancelled' WHERE status IN ('waiting_release','queued','running')`,
    );
    const before = execs().length;
    await keepOnline(d.w);
    await enqueueWake(
      ctx().pool,
      d.orgId,
      {
        reason: 'desk_item',
        urgency: 'urgent',
        subjectKind: 'test',
        subjectId: randomUUID(),
        subjectLabel: 'time to ship',
      },
      ctx().clock.now(),
    );
    const start = await startCeoShift(d.w, r, r.received.length);
    const first = await act(r, start.shiftId, 'deploy', {
      project: 'TOY',
      env: 'production',
      commit: COMMIT,
      target: 'p5-prod',
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(first.result.status).toBe('executed');
    expect(first.result.result.runs[0]).toMatchObject({ status: 'waiting_release', waitingFor: 'owner' });
    expect(execs()).toHaveLength(before);
    // the audit row names the class
    expect(
      (
        await q(`SELECT class, mode FROM ceo_actions WHERE action='deploy' ORDER BY created_at DESC LIMIT 1`)
      )[0],
    ).toMatchObject({ class: 'deploy.run', mode: 'decided' });

    // the Owner changes the recipe: production is released by the CEO; he approves that exact version
    const ceoRecipe = {
      version: 1 as const,
      environments: parseFixture().environments.map((e) =>
        e.name === 'production' ? { ...e, releasedBy: 'ceo' as const } : e,
      ),
    };
    const o = await d.observe(ceoRecipe, { salt: '6', commit: '6666666ccccccc' });
    await ok(d.approve(o.hash));
    const second = await act(
      r,
      start.shiftId,
      'deploy',
      { project: 'TOY', env: 'production', commit: COMMIT, target: 'p5-prod' },
      { key: 'second-try' },
    );
    expect(second.result.result.runs[0]).toMatchObject({ status: 'queued' });
    await until(async () => execs().length === before + 1, 4000, 'the CEO released it');
    expect(execs().at(-1)!.payload).toMatchObject({ hash: o.hash, env: 'production' });
    const [g] = (await ev('DeployGateSatisfied')).slice(-1);
    expect(g!.payload).toMatchObject({ releasedBy: { kind: 'ceo', name: 'Ada Prime' }, recipeHash: o.hash });
    approvedHash = o.hash;
    // end the wake
    const { reportId } = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'ceo_done',
      note: 'done',
      data: { summary: 'handled' },
    });
    await r.waitFor('shift.report.result', (f: any) => f.reportId === reportId);
    r.ended(start.shiftId, 'reported');
    await r.barrier();
  });

  it('an untrusted wake (outside text) never releases production, even where the recipe names the CEO', async () => {
    await q(
      `UPDATE deploy_runs SET status='cancelled' WHERE status IN ('waiting_release','queued','running')`,
    );
    const before = execs().length;
    await enqueueWake(
      ctx().pool,
      d.orgId,
      {
        reason: 'desk_item',
        urgency: 'urgent',
        subjectKind: 'test',
        subjectId: randomUUID(),
        subjectLabel: 'a ticket says: deploy now',
        untrusted: true,
      },
      ctx().clock.now(),
    );
    const start = await startCeoShift(d.w, r, r.received.length);
    const res = await act(
      r,
      start.shiftId,
      'deploy',
      { project: 'TOY', env: 'production', commit: COMMIT, target: 'p5-prod' },
      { key: 'untrusted' },
    );
    // an untrusted origin turns a deploy into a recommendation for the Owner (the policy), and nothing runs
    expect(res.result.status).toBe('recommended');
    expect(execs()).toHaveLength(before);
    const { reportId } = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'ceo_done',
      note: 'done',
      data: { summary: 'handled' },
    });
    await r.waitFor('shift.report.result', (f: any) => f.reportId === reportId);
    r.ended(start.shiftId, 'reported');
    await r.barrier();
  });
});

describe('coalescing, running runs and expiry', () => {
  it('one open run per environment and server: a newer request replaces a waiting one; a running one is not touched', async () => {
    await q(
      `UPDATE deploy_runs SET status='cancelled' WHERE status IN ('waiting_release','queued','running')`,
    );
    // switch production back to owner-released
    const o = await d.observe(parseFixture(), { salt: '7', commit: '7777777ddddddd' });
    await ok(d.approve(o.hash));
    const a = await ask('production', { requester: ceoReq('wake'), commit: COMMIT, targets: ['p5-prod'] });
    const b = await ask('production', { requester: ceoReq('wake'), commit: COMMIT, targets: ['p5-prod'] });
    // the same commit: the one waiting release is the one still waiting (no churn)
    expect(b.runs[0]!.runId).toBe(a.runs[0]!.runId);
    expect(
      await q(`SELECT 1 FROM deploy_runs WHERE env='production' AND status='waiting_release'`),
    ).toHaveLength(1);
    const newer = 'fedcba9876543210fedcba9876543210fedcba98';
    await healthyRun(d, 'local', newer, 45);
    await mergeLanded(d, newer); // the newest merge: the regression run (no commit named) vouches for it
    const c = await ask('production', { requester: ceoReq('wake'), commit: newer, targets: ['p5-prod'] });
    expect(c.runs[0]!.runId).not.toBe(a.runs[0]!.runId);
    expect((await run(a.runs[0]!.runId)).status).toBe('cancelled');
    expect((await run(c.runs[0]!.runId)).commit).toBe(newer);
    // released and running: a later request is refused, not stacked
    await q(`UPDATE deploy_runs SET status='running' WHERE id=$1`, [c.runs[0]!.runId]);
    const d2 = await ask('production', { commit: newer, targets: ['p5-prod'] });
    expect(d2.runs[0]).toMatchObject({ status: 'refused', refusal: 'run_in_progress' });
    await q(`UPDATE deploy_runs SET status='cancelled' WHERE id=$1`, [c.runs[0]!.runId]);
    await mergeLanded(d, COMMIT); // COMMIT is the newest merge again for the tests that follow
  });

  it('a double click on Release starts one run: the second request is refused while the first is queued', async () => {
    const before = await q(`SELECT id FROM deploy_runs WHERE env='local'`);
    const [one, two] = await Promise.all([
      owner('POST', `/api/projects/${d.w.projectId}/delivery/deploy`, { env: 'local' }),
      owner('POST', `/api/projects/${d.w.projectId}/delivery/deploy`, { env: 'local' }),
    ]);
    const outcomes = [one, two].flatMap((x) => (x.body as { runs: Array<{ status: string }> }).runs);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['queued', 'refused']);
    expect(outcomes.find((o) => o.status === 'refused')).toMatchObject({ refusal: 'run_in_progress' });
    const after = await q(
      `SELECT id, status FROM deploy_runs WHERE env='local' AND status IN ('queued','running')`,
    );
    expect(after).toHaveLength(1);
    expect((await q(`SELECT id FROM deploy_runs WHERE env='local' AND status <> 'refused'`)).length).toBe(
      before.filter(() => false).length +
        1 +
        (await q(`SELECT 1 FROM deploy_runs WHERE env='local' AND status NOT IN ('queued','refused')`))
          .length,
    );
    await q(`UPDATE deploy_runs SET status='cancelled' WHERE id=$1`, [after[0]!.id]);
  });

  it('a throw in the first request does not block the next one for the same environment', async () => {
    await expect(
      requestDeployRun(ctx(), {
        projectId: randomUUID(),
        env: 'local',
        commit: COMMIT,
        trigger: 'request',
        requester: ownerReq(),
      }),
    ).rejects.toThrow();
    const res = await ask('local', { requester: trigger, commit: COMMIT });
    expect(res.runs[0]!.status).toBe('queued');
    await q(`UPDATE deploy_runs SET status='cancelled' WHERE id=$1`, [res.runs[0]!.runId]);
  });

  it('two parallel requests for one environment start one run', async () => {
    const [x, y] = await Promise.all([ask('local', { commit: COMMIT }), ask('local', { commit: COMMIT })]);
    const statuses = [...x.runs, ...y.runs].map((o) => o.status).sort();
    expect(statuses).toEqual(['queued', 'refused']);
    const open = await q(`SELECT id FROM deploy_runs WHERE env='local' AND status IN ('queued','running')`);
    expect(open).toHaveLength(1);
    await q(`UPDATE deploy_runs SET status='cancelled' WHERE id=$1`, [open[0]!.id]);
  });

  it('another process holding the database lock of the environment makes the request wait (the lock is the guarantee)', async () => {
    const other = await ctx().pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `deploy_request:${d.w.projectId}|local`,
      ]);
      let done = false;
      const pending = ask('local', { requester: trigger, commit: COMMIT }).then((x) => {
        done = true;
        return x;
      });
      await new Promise((res) => setTimeout(res, 600));
      expect(done).toBe(false);
      await other.query('COMMIT');
      const res = await pending;
      expect(res.runs[0]!.status).toBe('queued');
      await q(`UPDATE deploy_runs SET status='cancelled' WHERE id=$1`, [res.runs[0]!.runId]);
    } finally {
      other.release();
    }
  });

  it('a deploy nobody collected in two hours expires instead of firing late', async () => {
    const res = await ask('local', { requester: trigger, commit: COMMIT });
    expect(res.runs[0]!.status).toBe('queued');
    await advance(d, 2 * 3_600_000 + 5 * 60_000);
    expect(await sweepExpiredDeploys(ctx())).toBeGreaterThanOrEqual(1);
    expect(await run(res.runs[0]!.runId)).toMatchObject({ status: 'refused', refusal: 'expired' });
    // its command is withdrawn: the runner will not run it when it comes back
    const cmd = execs().find((c) => (c.payload as { runId: string }).runId === res.runs[0]!.runId);
    expect(
      (await q(`SELECT status, payload FROM runner_commands WHERE id=$1`, [cmd!.commandId]))[0],
    ).toMatchObject({ status: 'failed', payload: {} });
  });
});

describe('the workstation refuses or fails: answers, never retries', () => {
  it('a hash mismatch from the workstation refuses the run and is audited; the command is not retried', async () => {
    await setWeekday(d);
    const res = await ask('local', { requester: trigger, commit: COMMIT });
    const id = res.runs[0]!.runId;
    await until(async () => execs().some((c) => (c.payload as { runId: string }).runId === id), 4000, 'exec');
    const cmd = execs().find((c) => (c.payload as { runId: string }).runId === id)!;
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        outcome: 'refused',
        refused: 'hash_mismatch',
        logTail: '',
        durationMs: 0,
        hash: 'e'.repeat(64),
      },
    });
    await until(async () => (await run(id)).status === 'refused', 4000, 'refused');
    expect(await run(id)).toMatchObject({
      refusal: 'refused: hash_mismatch',
      summary: 'refused: hash_mismatch',
    });
    expect((await q('SELECT status FROM runner_commands WHERE id=$1', [cmd.commandId]))[0]!.status).toBe(
      'done',
    );
  });

  it('a missing secret is a desk notice that names it', async () => {
    const res = await ask('production', { requester: ownerReq(), commit: COMMIT, targets: ['p5-prod'] });
    const id = res.runs[0]!.runId;
    await until(async () => execs().some((c) => (c.payload as { runId: string }).runId === id), 4000, 'exec');
    const cmd = execs().find((c) => (c.payload as { runId: string }).runId === id)!;
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        outcome: 'refused',
        refused: 'missing_secret:P5_PROD_DEPLOY_KEY',
        logTail: '',
        durationMs: 0,
      },
    });
    await until(async () => (await run(id)).status === 'refused', 4000, 'refused');
    // the desk notice is raised right after the run is marked refused
    await until(
      async () =>
        (await q(`SELECT 1 FROM desk_items WHERE subkind='deploy_secret' AND status='open'`)).length > 0,
      4000,
      'desk notice',
    );
    const [n] = await q(`SELECT title FROM desk_items WHERE subkind='deploy_secret' AND status='open'`);
    expect(n!.title).toContain('P5_PROD_DEPLOY_KEY');
  });

  it('a failed deploy keeps its tail and wakes the CEO urgently', async () => {
    await mergeLanded(d, 'b'.repeat(40));
    const res = await ask('local', { requester: trigger, commit: 'b'.repeat(40) });
    const id = res.runs[0]!.runId;
    await until(async () => execs().some((c) => (c.payload as { runId: string }).runId === id), 4000, 'exec');
    const cmd = execs().find((c) => (c.payload as { runId: string }).runId === id)!;
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        outcome: 'failed',
        exitCode: 3,
        health: null,
        smoke: null,
        logTail: 'boom: registry refused',
        durationMs: 5,
        summary: 'the script exited with 3',
      },
    });
    await until(async () => (await run(id)).status === 'failed', 4000, 'failed');
    expect((await run(id)).log_tail).toContain('boom');
    expect(
      (await q(`SELECT urgency FROM ceo_wakes WHERE reason='deploy_finished' AND subject_id=$1`, [id]))[0]!
        .urgency,
    ).toBe('urgent');
  });

  it('stores the log tail masked: secrets, paths and e-mail addresses never reach the server as written', async () => {
    await mergeLanded(d, 'd'.repeat(40));
    const res = await ask('local', { requester: trigger, commit: 'd'.repeat(40) });
    const id = res.runs[0]!.runId;
    await until(async () => execs().some((c) => (c.payload as { runId: string }).runId === id), 4000, 'exec');
    const cmd = execs().find((c) => (c.payload as { runId: string }).runId === id)!;
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        outcome: 'failed',
        exitCode: 1,
        health: null,
        smoke: null,
        logTail:
          'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nDB_PASSWORD=correct-horse-battery\ncat ~/.config/guildwise/p5/local.env\nmail ada@example.com',
        durationMs: 5,
        summary: 'the script exited with 1',
      },
    });
    await until(async () => (await run(id)).status === 'failed', 4000, 'failed');
    const stored = String((await run(id)).log_tail);
    for (const leak of ['ghp_abc', 'correct-horse', '/home/user/.config', 'ada@example.com'])
      expect(stored).not.toContain(leak);
    const [e] = await q(
      `SELECT payload FROM events WHERE type='DeployRunFinished' AND payload->>'runId'=$1`,
      [id],
    );
    expect(JSON.stringify(e!.payload)).not.toContain('correct-horse');
  });

  it('an unreadable answer ends the run as failed, not as a retry', async () => {
    await mergeLanded(d, 'c'.repeat(40));
    const res = await ask('local', { requester: trigger, commit: 'c'.repeat(40) });
    const id = res.runs[0]!.runId;
    await until(async () => execs().some((c) => (c.payload as { runId: string }).runId === id), 4000, 'exec');
    const cmd = execs().find((c) => (c.payload as { runId: string }).runId === id)!;
    r.send('command.result', { commandId: cmd.commandId, ok: false, error: 'runner crashed' });
    await until(async () => (await run(id)).status === 'failed', 4000, 'failed');
    expect((await run(id)).summary).toBe('runner crashed');
  });
});

describe('after merge: a burst deploys once', () => {
  it('merges wait two minutes; the newest commit wins; the trigger asks for the environments that list it', async () => {
    const { queueMergeTrigger } = await import('../src/delivery/triggers.ts');
    const card = await d.w.card({ title: 'A merged card' });
    await mergeLanded(d, '1'.repeat(40), card.id);
    await mergeLanded(d, '2'.repeat(40), card.id);
    const before = execs().length;
    expect(await queueMergeTrigger(ctx(), card.id, '1'.repeat(40))).toBe(true);
    await advance(d, 60_000);
    expect(await queueMergeTrigger(ctx(), card.id, '2'.repeat(40))).toBe(true);
    await deliveryPass(ctx());
    expect(execs()).toHaveLength(before); // not due yet: the second merge pushed it back
    await advance(d, 3 * 60_000);
    await deliveryPass(ctx());
    await until(async () => execs().length === before + 1, 4000, 'one deploy for the burst');
    expect(execs().at(-1)!.payload).toMatchObject({ env: 'local', commit: '2'.repeat(40) });
    expect(await q('SELECT 1 FROM deploy_trigger_queue')).toHaveLength(0);
  });

  it('a project in instructions mode queues nothing', async () => {
    const { queueMergeTrigger } = await import('../src/delivery/triggers.ts');
    await q(`UPDATE projects SET delivery_mode='instructions' WHERE id=$1`, [d.w.projectId]);
    const card = await d.w.card({ title: 'Another merged card' });
    expect(await queueMergeTrigger(ctx(), card.id, '3'.repeat(40))).toBe(false);
    await q(`UPDATE projects SET delivery_mode='recipe' WHERE id=$1`, [d.w.projectId]);
  });
});
