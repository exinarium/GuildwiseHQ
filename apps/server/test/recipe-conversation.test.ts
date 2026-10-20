import { randomUUID } from 'node:crypto';
import { type BundleEntry, bundleHash, type RecipeInspectResult } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from './helpers/browser.ts';
import { act, keepOnline, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { type DeliveryWorld, deliveryWorld, mergeLanded, parseFixture } from './helpers/delivery.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { ok, until } from './helpers/world.ts';

/**
 * Creating a recipe in conversation (docs/design/ceo-front-door.md section 10): the CEO drafts with the Owner and delegates
 * the scripting and the trial run to DevOps; DevOps saves the files into the project vault and trials them; only the Owner's
 * button approves. A trial is allowed only for a recipe request the CEO filed from the Owner's own turn.
 */
const FULL_POWER = ['ceo:1', 'ceo-full-power:1', 'delivery:1'];
let d: DeliveryWorld;
let r: FakeRunner;
let b: Browser;
let threadId: string;
let current: any;
let seq = 0;

beforeAll(async () => {
  d = await deliveryWorld({ env: { AOM_MOCK_UI: 'true' } });
  r = await d.w.connectRunner({ capabilities: FULL_POWER });
  await keepOnline(d.w);
  await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
    d.w.workstationId,
    FULL_POWER,
  ]);
  // the commits the tests deploy were really merged (an automated requester may deploy only those)
  await mergeLanded(d, 'a'.repeat(40));
  await mergeLanded(d, 'b'.repeat(40));
  threadId = (await d.w.t.req('POST', '/api/ceo/chat', { cookie: d.w.owner.cookie })).body.threadId;
  b = await Browser.open(d.w.baseUrl, d.w.owner.cookie);
  await b.hello();
});
afterAll(async () => {
  b.close();
  r.close();
  await d.w.t.close();
  await closeAdminPool();
});

async function openTurn(text = `turn ${++seq}`) {
  b.send({ type: 'chat.send', threadId, body: text, clientMsgId: `m-${seq}-${Math.random()}` });
  current = (await r.waitFor('chat.start', (f: any) => f.message === text)) as any;
  return current;
}
async function finishTurn(start: any) {
  r.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: 'done',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    runtimeSessionId: 'sess-x',
  });
  await until(
    async () =>
      (await q(`SELECT 1 FROM ceo_turns WHERE id=$1 AND status='done'`, [start.chatId])).length === 1,
    5000,
    'turn done',
  );
}
async function rpc(shiftId: string, method: string, params: Record<string, unknown>) {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId, method, params });
  return (await r.waitFor('rpc.response', (f: any) => f.rpcId === rpcId, 8000, from)) as any;
}
async function devopsShift(requestId: string) {
  const from = r.received.length;
  await d.w.t.app.ctx.services.dispatcher.run();
  const start = (await r.waitFor('shift.start', (f: any) => f.kind === 'devops', 8000, from)) as any;
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () =>
      (await q(`SELECT status FROM devops_requests WHERE id=$1`, [requestId]))[0]!.status === 'running',
    5000,
    'running',
  );
  return start as { shiftId: string };
}
async function finishDevops(shiftId: string) {
  const { reportId } = r.report(shiftId, {
    kind: 'outcome',
    outcomeId: 'devops_done',
    note: 'done',
    data: { summary: 'recipe saved and trialled', commands: [] },
  });
  await r.waitFor('shift.report.result', (f: any) => f.reportId === reportId);
  r.ended(shiftId, 'reported');
  await r.barrier();
}
const execs = () => r.of('command').filter((c) => c.command === 'deploy.exec');

/** What the workstation reports after it saved the drafted files. */
function inspected(): { inspected: RecipeInspectResult; hash: string } {
  const recipe = parseFixture();
  const files: BundleEntry[] = [
    { path: 'recipe.yaml', mode: '644', sha256: 'a'.repeat(64) },
    ...['scripts/local.sh', 'scripts/smoke-local.sh', 'scripts/production.sh'].map(
      (p): BundleEntry => ({ path: p, mode: '755', sha256: 'b'.repeat(64) }),
    ),
  ];
  const hash = bundleHash(files);
  return {
    hash,
    inspected: {
      ok: true,
      present: true,
      vaultCommit: null,
      hash,
      files: files.map((f) => ({ ...f, secret: null })),
      recipe,
      lint: [],
    },
  };
}

describe('the recipe request', () => {
  it('a wake cannot ask DevOps to draft a recipe: it is a conversation with the Owner', async () => {
    await wakeNow(d.w);
    const wake = await startCeoShift(d.w, r, r.received.length);
    const res = await act(r, wake.shiftId, 'devops', {
      project: 'TOY',
      kind: 'recipe',
      text: 'Set up deploys for the toy app',
    });
    expect(res.result.status).toBe('refused');
    expect(res.result.message).toContain('conversation with the Owner');
    const { reportId } = r.report(wake.shiftId, {
      kind: 'outcome',
      outcomeId: 'ceo_done',
      note: 'done',
      data: { summary: 'handled' },
    });
    await r.waitFor('shift.report.result', (f: any) => f.reportId === reportId);
    r.ended(wake.shiftId, 'reported');
    await r.barrier();
  });

  let requestId: string;
  let shiftId: string;
  it("from the Owner's turn the request carries the recipe context and the contract DevOps must follow", async () => {
    const turn = await openTurn('Set up deploys for TOY: local first, then production');
    const res = await act(r, turn.chatId, 'devops', {
      project: 'TOY',
      kind: 'recipe',
      text: 'Local: p5-local after merge. Production: p5-prod, released by me, gate: local healthy 30 minutes and regression passed.',
    });
    expect(res.result.status, JSON.stringify(res)).toBe('executed');
    requestId = res.result.result.requestId;
    const [row] = await q('SELECT summary, context, origin FROM devops_requests WHERE id=$1', [requestId]);
    expect(row).toMatchObject({ origin: 'ceo' });
    expect(row!.context).toMatchObject({
      requestKind: 'recipe',
      ownerTurn: true,
      projectKey: 'TOY',
      projectId: d.w.projectId,
    });
    expect(row!.summary).toContain('DELIVERY RECIPE request for project TOY');
    expect(row!.summary).toContain('AOM_DEPLOY_DRY_RUN=1');
    expect(row!.summary).toContain('aom recipe save');
    await finishTurn(turn);
    shiftId = (await devopsShift(requestId)).shiftId;
  });

  it('DevOps saves the recipe: the workstation names the project vault, the result is observed, never approved', async () => {
    const begin = await rpc(shiftId, 'recipe.save', { phase: 'begin', project: 'TOY' });
    expect(begin.ok, JSON.stringify(begin)).toBe(true);
    expect(begin.result).toMatchObject({
      projectId: d.w.projectId,
      vault: { vaultId: d.vaultId, storage: 'local', folder: 'projects/toy' },
    });
    const { inspected: ins, hash } = inspected();
    const done = await rpc(shiftId, 'recipe.save', { phase: 'done', project: 'TOY', inspected: ins });
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect(done.result).toMatchObject({ recorded: true, status: 'observed', hash });
    expect(
      (await q('SELECT status, approved_hash FROM delivery_recipes WHERE project_id=$1', [d.w.projectId]))[0],
    ).toMatchObject({ status: 'observed', approved_hash: null });
  });

  it('a trial runs the unapproved recipe on a non-production environment; production only gets a dry run', async () => {
    const local = await rpc(shiftId, 'deploy.trial', { env: 'local' });
    expect(local.ok, JSON.stringify(local)).toBe(true);
    expect(local.result.runs[0]).toMatchObject({ status: 'queued', target: 'p5-local' });
    await until(async () => execs().length === 1, 4000, 'trial exec');
    const { hash } = inspected();
    expect(execs()[0]!.payload).toMatchObject({ env: 'local', trial: true, dryRun: false, hash });
    const row = (
      await q('SELECT trial, dry_run, status FROM deploy_runs WHERE id=$1', [local.result.runs[0].runId])
    )[0];
    expect(row).toMatchObject({ trial: true, dry_run: false, status: 'queued' });
    const prod = await rpc(shiftId, 'deploy.trial', { env: 'production' });
    expect(prod.result.runs[0]).toMatchObject({ status: 'queued' });
    await until(async () => execs().length === 2, 4000, 'dry-run exec');
    expect(execs()[1]!.payload).toMatchObject({ env: 'production', trial: true, dryRun: true });
    // a trial never counts as a deploy for a gate: no healthy run of `local` exists
    expect(await q(`SELECT 1 FROM deploy_runs WHERE trial AND status='succeeded'`)).toHaveLength(0);
  });

  it('DevOps asks for a real deploy: the recipe is not approved, so it refuses; status shows the hash for the Owner', async () => {
    const real = await rpc(shiftId, 'deploy.run', { env: 'local' });
    expect(real.result.runs[0]).toMatchObject({ status: 'refused', refusal: 'not_recipe_mode' });
    const status = await rpc(shiftId, 'deploy.status', { project: 'TOY' });
    expect(status.result.recipe).toMatchObject({
      status: 'observed',
      hash: inspected().hash,
      approvedHash: null,
    });
    expect(status.result.runs.length).toBeGreaterThanOrEqual(2);
    await finishDevops(shiftId);
  });

  it('the Owner approves and switches the project to recipe delivery; DevOps still only asks (an owner-released environment waits)', async () => {
    const { hash } = inspected();
    expect((await d.approve(hash)).status).toBe(200);
    expect(
      (
        await d.w.t.req('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, {
          cookie: d.w.owner.cookie,
          body: { mode: 'recipe' },
        })
      ).status,
    ).toBe(200);
    // another DevOps request, a plain one (not a recipe request from the Owner's turn)
    const turn = await openTurn('Please check the docker setup');
    const plain = await act(r, turn.chatId, 'devops', {
      project: 'TOY',
      text: 'Check the docker setup of the toy app',
    });
    const reqId = plain.result.result.requestId;
    await finishTurn(turn);
    const s2 = (await devopsShift(reqId)).shiftId;
    const trial = await rpc(s2, 'deploy.trial', { env: 'local' });
    expect(trial.ok).toBe(false);
    expect(trial.error).toContain('recipe request the CEO filed');
    const save = await rpc(s2, 'recipe.save', { phase: 'begin', project: 'TOY' });
    expect(save.ok).toBe(false);
    // DevOps may ask for the automatic environment; production waits for the Owner
    const prod = await rpc(s2, 'deploy.run', { env: 'production', commit: 'a'.repeat(40) });
    expect(prod.result.runs[0]).toMatchObject({ status: 'refused', refusal: 'gate_unsatisfied' });
    await finishDevops(s2);
  });
});

describe("in the Owner's own turn the model is still not the releaser", () => {
  const plain = (releasedBy: 'owner' | 'ceo') => ({
    version: 1 as const,
    environments: parseFixture().environments.map((e) =>
      e.name === 'production' ? { ...e, gate: 'none' as const, releasedBy } : e,
    ),
  });

  it('an owner-released environment waits in the queue even when the Owner is in the conversation; a CEO-released one runs', async () => {
    const o = await d.observe(plain('owner'), { salt: '8', commit: '8888888eeeeeee' });
    await ok(d.approve(o.hash));
    const before = execs().length;
    const turn = await openTurn('Ship the toy app to production');
    const wait = await act(r, turn.chatId, 'deploy', {
      project: 'TOY',
      env: 'production',
      commit: 'a'.repeat(40),
    });
    expect(wait.result.status, JSON.stringify(wait)).toBe('executed');
    expect(wait.result.result.runs[0]).toMatchObject({ status: 'waiting_release', waitingFor: 'owner' });
    expect(execs()).toHaveLength(before);
    // the Owner presses Release (his session): that is the release
    const queue = await d.w.t.req('GET', '/api/delivery/queue', { cookie: d.w.owner.cookie });
    const runId = queue.body.items[0].targets[0].runId;
    const rel = await d.w.t.req('POST', '/api/delivery/release', {
      cookie: d.w.owner.cookie,
      body: { runIds: [runId] },
    });
    expect(rel.body.runs[0].status).toBe('queued');
    await until(async () => execs().length === before + 1, 4000, 'released by the Owner');
    await finishTurn(turn);
    const n = await d.observe(plain('ceo'), { salt: '9', commit: '9999999fffffff' });
    await ok(d.approve(n.hash));
    await q(
      `UPDATE deploy_runs SET status='cancelled' WHERE status IN ('queued','running','waiting_release')`,
    );
    const turn2 = await openTurn('And again');
    const go = await act(r, turn2.chatId, 'deploy', {
      project: 'TOY',
      env: 'production',
      commit: 'b'.repeat(40),
    });
    expect(go.result.result.runs[0]).toMatchObject({ status: 'queued' });
    const [g] = await q(
      `SELECT payload FROM events WHERE type='DeployGateSatisfied' ORDER BY seq DESC LIMIT 1`,
    );
    expect(g!.payload).toMatchObject({ releasedBy: { kind: 'ceo' } });
    await finishTurn(turn2);
  });
});
