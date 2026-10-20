import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestDeployRun } from '../src/delivery/runs.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { type DeliveryWorld, deliveryWorld, P5_RECIPE_YAML, parseFixture } from './helpers/delivery.ts';
import { ok } from './helpers/world.ts';

/**
 * Recipe approval and the content hash (docs/design/ceo-front-door.md 9.4 and 14): the Owner's button approves exactly the hash
 * he saw; a recipe that changed since refuses runs until it is approved again; the audit says who approved which hash.
 */
let d: DeliveryWorld;
beforeAll(async () => {
  d = await deliveryWorld();
});
afterAll(async () => {
  await d.w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown, cookie = d.w.owner.cookie) =>
  d.w.t.req(method, url, { cookie, ...(body === undefined ? {} : { body }) });
const settings = (cookie = d.w.owner.cookie) =>
  ok<any>(owner('GET', `/api/projects/${d.w.projectId}/delivery`, undefined, cookie));
const recipeRow = async () =>
  (await q('SELECT * FROM delivery_recipes WHERE project_id=$1', [d.w.projectId]))[0]!;
const events = (type: string) => q('SELECT payload FROM events WHERE type=$1 ORDER BY seq', [type]);
const ask = (env: string) =>
  requestDeployRun(d.w.t.app.ctx, {
    projectId: d.w.projectId,
    env,
    trigger: 'request',
    requester: { kind: 'owner', id: d.w.owner.id, provenance: 'session' },
  });

describe('observing a recipe', () => {
  it('records what the workstation found: a hash, the parsed recipe, the environments and who releases each', async () => {
    const { hash } = await d.observe();
    const s = await settings();
    expect(s.recipe).toMatchObject({
      status: 'observed',
      observedHash: hash,
      approvedHash: null,
      version: 0,
      fileCount: 4,
    });
    expect(s.vault).toMatchObject({ storage: 'local', folder: 'projects/toy' });
    expect(s.environments.map((e: any) => [e.name, e.releasedBy])).toEqual([
      ['local', 'auto'],
      ['production', 'owner'],
    ]);
    expect(s.environments[1].targets).toEqual([{ name: 'p5-prod', production: true, exists: true }]);
    expect(s.canApprove).toBe(true);
    // it waits on the desk for the Owner: an alert, never an answerable question
    const [item] = await q(`SELECT kind, subkind, status FROM desk_items WHERE subkind='recipe_approval'`);
    expect(item).toMatchObject({ kind: 'alert', status: 'open' });
  });

  it('an unapproved recipe cannot be switched on, and refuses: nothing runs from a recipe the Owner never approved', async () => {
    await ok(owner('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, { mode: 'recipe' }), 422);
    const r = await ask('local');
    expect(r.runs[0]).toMatchObject({ status: 'refused', refusal: 'not_recipe_mode' });
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='deploy.exec'`)).toHaveLength(0);
  });

  it('the same observation again changes nothing (a vault sync asks often)', async () => {
    const before = (await events('DeliveryRecipeObserved')).length;
    await d.observe();
    expect((await events('DeliveryRecipeObserved')).length).toBe(before);
  });
});

describe('approving (an Owner button, never relayed text)', () => {
  it('only the Owner approves; an Admin and a member are refused', async () => {
    const { hash } = await d.observe();
    const admin = await d.admin();
    const member = await d.member();
    const asAdmin = await d.approve(hash, admin.cookie);
    expect(asAdmin.status).toBe(403);
    expect((await d.approve(hash, member.cookie)).status).toBeGreaterThanOrEqual(403);
    expect((await recipeRow()).status).toBe('observed');
  });

  it('approves only the hash that was observed: a hash the Owner did not see is refused', async () => {
    const r = await d.approve('f'.repeat(64));
    expect(r.status).toBe(409);
    expect(r.body.error?.code ?? r.body.code).toBe('recipe_changed');
    expect((await recipeRow()).approved_hash).toBeNull();
  });

  it('lint errors block an approval', async () => {
    const { hash } = await d.observe(parseFixture(), {
      salt: '1',
      lint: [{ level: 'error', code: 'missing_script', message: 'scripts/x.sh is not in delivery/' }],
    });
    const r = await d.approve(hash);
    expect(r.status).toBe(422);
    expect((await recipeRow()).status).toBe('observed');
  });

  it('records DeliveryRecipeApproved with who approved which hash, at which vault commit', async () => {
    const { hash } = await d.observe(parseFixture(), { salt: '2', commit: 'abc1234def' });
    const r = await d.approve(hash);
    expect(r.status).toBe(200);
    expect(r.body.recipe).toMatchObject({
      status: 'approved',
      approvedHash: hash,
      approvedCommit: 'abc1234def',
      version: 1,
    });
    const [ev] = (await events('DeliveryRecipeApproved')).slice(-1);
    expect(ev!.payload).toMatchObject({ hash, vaultCommit: 'abc1234def', by: d.w.owner.id, version: 1 });
    // the desk notice closed
    expect(
      await q(`SELECT 1 FROM desk_items WHERE subkind='recipe_approval' AND status='open'`),
    ).toHaveLength(0);
    // approving it again is a no-op, not a second version
    await d.approve(hash);
    expect((await recipeRow()).version).toBe(1);
  });
});

describe('a changed recipe needs a new approval', () => {
  it('a changed hash flips the status, raises a drift event and an approval notice, and runs refuse', async () => {
    const approved = (await recipeRow()).approved_hash as string;
    const { hash } = await d.observe(parseFixture(), { salt: '3', commit: 'def5678abc' });
    expect(hash).not.toBe(approved);
    expect(await recipeRow()).toMatchObject({
      status: 'changed_unapproved',
      approved_hash: approved,
      observed_hash: hash,
    });
    expect((await events('DeliveryRecipeDrifted')).slice(-1)[0]!.payload).toMatchObject({
      hash,
      approvedHash: approved,
    });
    const s = await settings();
    expect(s.recipe.changes.length).toBeGreaterThan(0);
    expect(s.recipe.changes.join('\n')).toContain('recipe.yaml content changed');
    expect(
      await q(`SELECT 1 FROM desk_items WHERE subkind='recipe_approval' AND status='open'`),
    ).toHaveLength(1);
    await ok(owner('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, { mode: 'recipe' }));
    const refused = await ask('local');
    expect(refused.runs[0]).toMatchObject({ status: 'refused', refusal: 'recipe_changed' });
    // the refusal is audited as a row of its own
    const [row] = await q(`SELECT status, refusal FROM deploy_runs WHERE id=$1`, [refused.runs[0]!.runId]);
    expect(row).toMatchObject({ status: 'refused', refusal: 'recipe_changed' });
  });

  it('what was approved is what runs: the previous approval stays in force until a new one, and re-approving fixes it', async () => {
    const row = await recipeRow();
    expect(row.approved_hash).not.toBe(row.observed_hash);
    const r = await d.approve(row.observed_hash);
    expect(r.status).toBe(200);
    expect(await recipeRow()).toMatchObject({
      status: 'approved',
      version: 2,
      approved_hash: row.observed_hash,
    });
    // observing the OLD content again is a change from the approved one
    const back = await d.observe(parseFixture(), { salt: '2', commit: 'abc1234def' });
    expect(back.hash).not.toBe(row.observed_hash);
    expect((await recipeRow()).status).toBe('changed_unapproved');
    await d.observe(parseFixture(), { salt: '3', commit: 'def5678abc' });
    expect((await recipeRow()).status).toBe('approved');
  });
});

describe('delivery mode', () => {
  it('instructions is the default; recipe needs an approved recipe; switching back is always allowed', async () => {
    expect((await settings()).mode).toBe('recipe');
    const back = await ok<any>(
      owner('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, { mode: 'instructions' }),
    );
    expect(back.mode).toBe('instructions');
    const ev = await events('DeliveryModeSet');
    expect(ev.map((e) => e.payload.mode)).toEqual(['recipe', 'instructions']);
    const member = await d.member();
    expect(
      (await owner('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, { mode: 'recipe' }, member.cookie))
        .status,
    ).toBeGreaterThanOrEqual(403);
    // instructions mode: a deploy request is refused, today's phase path is unchanged
    const r = await ask('local');
    expect(r.runs[0]).toMatchObject({ refusal: 'not_recipe_mode' });
    await ok(owner('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, { mode: 'recipe' }));
  });

  it("rejecting an observed recipe is the Owner's too", async () => {
    const { hash } = await d.observe(parseFixture(), { salt: '4', commit: '1112223334' });
    const admin = await d.admin();
    expect(
      (await owner('POST', `/api/projects/${d.w.projectId}/delivery/reject`, { hash }, admin.cookie)).status,
    ).toBe(403);
    await ok(
      owner('POST', `/api/projects/${d.w.projectId}/delivery/reject`, { hash, reason: 'not like this' }),
    );
    expect((await events('DeliveryRecipeRejected')).slice(-1)[0]!.payload).toMatchObject({
      hash,
      by: d.w.owner.id,
    });
    expect(P5_RECIPE_YAML).toContain('releasedBy');
  });
});
