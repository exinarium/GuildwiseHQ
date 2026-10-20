import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import {
  type DeliveryWorld,
  deliveryWorld,
  healthyRun,
  parseFixture,
  passedRegression,
  setWeekday,
} from './helpers/delivery.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { ok, until } from './helpers/world.ts';

/**
 * A phase's deploy follow-up in a recipe project (docs/design/ceo-front-door.md 9.5): no prose DevOps request; the follow-up asks
 * for the environment's deploy run and finishes with it. A project in `instructions` mode is unchanged.
 */
let d: DeliveryWorld;
let r: FakeRunner;

beforeAll(async () => {
  d = await deliveryWorld({ env: { AOM_MOCK_UI: 'true' } });
  r = await d.w.connectRunner({ capabilities: ['ceo:1', 'delivery:1'] });
  await keepOnline(d.w);
  await setWeekday(d);
});
afterAll(async () => {
  r.close();
  await d.w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  d.w.t.req(method, url, {
    cookie: d.w.owner.cookie,
    headers: { 'x-aom-org': d.orgId },
    ...(body === undefined ? {} : { body }),
  });
const scope = () => ({ orgId: d.w.owner.id, projectId: d.w.projectId, audience: 'project' as const });
const dispatcher = () => ({
  runPass: async () => {
    await keepOnline(d.w);
    return d.w.t.app.ctx.services.dispatcher.runPass();
  },
});
const phaseRow = async (id: string) => (await q('SELECT * FROM phases WHERE id=$1', [id]))[0]!;
const followups = async (id: string) =>
  q('SELECT * FROM phase_followups WHERE phase_id=$1 ORDER BY position', [id]);
const execs = () => r.of('command').filter((c) => c.command === 'deploy.exec');

async function awaitingApproval(name: string, list: unknown[]) {
  const phase = await ok<any>(
    owner('POST', `/api/projects/${d.w.projectId}/phases`, { name, followups: list }),
    201,
  );
  const card = await d.w.card({ title: `${name} card`, specify: false });
  await ok(owner('PUT', `/api/cards/${card.id}/phase`, { phaseId: phase.id }));
  await seed(d.w, [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'CardFinalized',
        payload: {
          cardId: card.id,
          action: 'merge',
          resultRef: { mergeCommit: 'abc1234567' },
          toStage: 'done',
        },
      },
      actor: { kind: 'system', id: null },
      scope: scope(),
    },
  ]);
  await dispatcher().runPass();
  const row = await phaseRow(phase.id);
  expect(row.status).toBe('awaiting_approval');
  return { phase, itemId: row.report_desk_item_id as string };
}
const answer = (id: string, status: 'succeeded' | 'failed') => {
  const cmd = execs().find((c) => (c.payload as { runId: string }).runId === id)!;
  r.send('command.result', {
    commandId: cmd.commandId,
    ok: true,
    result: {
      outcome: status,
      exitCode: status === 'failed' ? 1 : 0,
      health: { ok: status === 'succeeded' },
      logTail: 'log',
      durationMs: 5,
      summary: status === 'failed' ? 'the script exited with 1' : 'deployed',
    },
  });
};

describe('recipe mode', () => {
  it('an instructions project is unchanged: the follow-up is a DevOps request, not a deploy run', async () => {
    const { phase, itemId } = await awaitingApproval('Prose', [
      { kind: 'deploy', targetId: d.targets.local },
    ]);
    await ok(owner('POST', `/api/desk/${itemId}/resolve`, { resolution: 'approved' }));
    await dispatcher().runPass();
    await dispatcher().runPass();
    const [f] = await followups(phase.id);
    expect(f!.status, f!.result_summary).toBe('running');
    expect(f!.devops_request_ids.length).toBeGreaterThan(0);
    expect(await q('SELECT 1 FROM deploy_runs')).toHaveLength(0);
    await q(`UPDATE phases SET status='cancelled' WHERE id=$1`, [phase.id]);
    await q(`UPDATE phase_followups SET status='cancelled' WHERE phase_id=$1`, [phase.id]);
  });

  it('a recipe project: the follow-up asks for the environment of its target, and finishes with the run', async () => {
    const o = await d.observe(parseFixture(), { commit: '9999999aaaaaaa' });
    await ok(d.approve(o.hash));
    await ok(owner('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, { mode: 'recipe' }));
    const { phase, itemId } = await awaitingApproval('Recipe local', [
      { kind: 'deploy', targetId: d.targets.local },
    ]);
    const devopsBefore = (await q('SELECT count(*)::int AS n FROM devops_requests'))[0]!.n;
    await ok(owner('POST', `/api/desk/${itemId}/resolve`, { resolution: 'approved' }));
    await dispatcher().runPass();
    await dispatcher().runPass();
    const [f] = await followups(phase.id);
    expect(f!.status, f!.result_summary).toBe('running');
    expect(f!.devops_request_ids).toEqual([]);
    expect((await q('SELECT count(*)::int AS n FROM devops_requests'))[0]!.n).toBe(devopsBefore);
    const [run] = await q(`SELECT * FROM deploy_runs WHERE phase_followup_id=$1`, [f!.id]);
    expect(run).toMatchObject({
      env: 'local',
      target_name: 'p5-local',
      status: 'queued',
      trigger: 'request',
    });
    // asked once, not on every pass
    await dispatcher().runPass();
    expect(await q(`SELECT 1 FROM deploy_runs WHERE phase_followup_id=$1`, [f!.id])).toHaveLength(1);
    await until(async () => execs().length >= 1, 4000, 'exec');
    answer(run!.id, 'succeeded');
    await until(
      async () =>
        (await q('SELECT status FROM deploy_runs WHERE id=$1', [run!.id]))[0]!.status === 'succeeded',
      4000,
      'run done',
    );
    await dispatcher().runPass();
    const [done] = await followups(phase.id);
    expect(done!.status).toBe('succeeded');
    expect(done!.evidence).toMatchObject({ deployRunIds: [run!.id] });
    expect(done!.result_summary).toContain('p5-local: deployed');
  });

  it('a production target waits in the release queue (the phase waits with it); cancelling the release fails the follow-up', async () => {
    await healthyRun(d, 'local', 'abc1234567', 45);
    const { phase, itemId } = await awaitingApproval('Recipe prod', [
      { kind: 'deploy', targetId: d.targets.prod },
    ]);
    // the regression run that tested this merge (a test run that names no commit counts only after the newest merge)
    await passedRegression(d, 0);
    await ok(owner('POST', `/api/desk/${itemId}/resolve`, { resolution: 'approved' }));
    await dispatcher().runPass();
    await dispatcher().runPass();
    const [f] = await followups(phase.id);
    const [run] = await q(`SELECT * FROM deploy_runs WHERE phase_followup_id=$1`, [f!.id]);
    expect(run, JSON.stringify([run!.refusal, run!.refusal_detail, run!.missing])).toMatchObject({
      env: 'production',
      status: 'waiting_release',
      commit: 'abc1234567',
      waiting_for: 'owner',
    });
    expect(f!.status).toBe('running');
    await ok(owner('POST', `/api/delivery/runs/${run!.id}/cancel`));
    await dispatcher().runPass();
    const [after] = await followups(phase.id);
    expect(after!.status).toBe('failed');
    expect(after!.result_summary).toContain('p5-prod');
  });

  it('an environment the recipe lacks for the target fails the follow-up at once, with the reason', async () => {
    await q(
      `INSERT INTO deploy_targets (id, org_id, project_id, name, kind, created_by, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'orphan', 'local_docker', $1, now(), now())`,
      [d.orgId, d.w.projectId],
    );
    const orphan = (await q(`SELECT id FROM deploy_targets WHERE name='orphan'`))[0]!.id;
    const { phase, itemId } = await awaitingApproval('Orphan', [{ kind: 'deploy', targetId: orphan }]);
    await ok(owner('POST', `/api/desk/${itemId}/resolve`, { resolution: 'approved' }));
    await dispatcher().runPass();
    await dispatcher().runPass();
    const [f] = await followups(phase.id);
    expect(f!.status).toBe('failed');
    expect(f!.result_summary).toContain('has no environment for orphan');
  });
});
