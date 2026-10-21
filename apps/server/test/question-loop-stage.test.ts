import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { detectLoops } from '../src/ceo/detectors.ts';
import { platformScan } from '../src/platform-team/detectors.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, type World } from './helpers/world.ts';

/** A question loop is filed under the stage its questions were asked in; stop-loss arbitrations do not count. */

let w: World;
let r: FakeRunner;
let root: { id: string; cookie: string; email: string };
let releaseDir: string;
let ctx: World['t']['app']['ctx'];
let orgId: string;
let platformProjectId: string;
let toyId: string;
let agentId: string;

beforeAll(async () => {
  releaseDir = mkdtempSync(join(tmpdir(), 'aom-release-'));
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_RUNNER_RELEASE_DIR: releaseDir } });
  ctx = w.t.app.ctx;
  r = await w.connectRunner({ capabilities: ['runner-pin:1'] });
  root = await w.t.superAdminSession();
  orgId = w.owner.id;
  toyId = w.projectId;
  const p = await ok<any>(
    w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'PLT', name: 'Platform' } }),
    201,
  );
  platformProjectId = p.project.id;
  await ok(
    w.t.req('POST', `/api/projects/${platformProjectId}/repos`, {
      cookie: w.owner.cookie,
      body: { name: 'toy', remoteUrl: 'https://github.com/acme/toy.git' },
    }),
    201,
  );
  await markOnline(w.t, w.workstationId, {
    repoIds: (await q('SELECT id FROM project_repos')).map((x) => x.id),
  });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  rmSync(releaseDir, { recursive: true, force: true });
  await closeAdminPool();
});
beforeEach(async () => {
  await freshState();
  await q(
    `TRUNCATE platform_pauses, platform_bugs, platform_bug_hits, platform_deploy_audit, platform_deploy_approvals,
       platform_diag_grants, platform_diag_access, workstation_runner_pins, runner_errors, runner_error_workstations,
       workstation_role_blocks RESTART IDENTITY CASCADE`,
  );
  await q(`DELETE FROM platform_settings WHERE key IN ('platform.team','runners.version_pin')`);
  ctx.services.dispatcher.cooldown.clear();
  await w.hire('Bea', 'builder', 'junior');
  agentId = (await q('SELECT id FROM agents WHERE name=$1', ['Bea']))[0]!.id as string;
});

const designate = () =>
  ok<any>(
    w.t.req('PUT', '/api/platform/team', {
      cookie: root.cookie,
      body: { orgId, projectId: platformProjectId },
    }),
  );
const bugRows = () => q('SELECT * FROM platform_bugs ORDER BY created_at');
const questionLoops = async (cardId: string) =>
  (await detectLoops(ctx.pool)).filter((l) => l.fingerprint === `loop:questions:${cardId}`);

/** A desk item asked about the card (its stage is the card's stage now), with `n` reported question shifts. */
async function askedItem(cardId: string, n: number, subkind: string | null = null) {
  const id = randomUUID();
  await q(
    `INSERT INTO desk_items (id, org_id, project_id, card_id, kind, subkind, status, routed_to, title, body, doing, options,
       blocking, affected_card_ids, asked_by_kind, asked_by_agent_id, pinned, stage, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'question',$5,'open','manager','Which delay?','','', '[]', true, ARRAY[$4::uuid],
       $6, $7, false, (SELECT stage FROM cards WHERE id=$4), now(), now())`,
    [id, orgId, toyId, cardId, subkind, subkind ? 'system' : 'agent', subkind ? null : agentId],
  );
  await shifts(id, n);
  return id;
}
async function shifts(itemId: string, n: number) {
  for (let i = 0; i < n; i++)
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, status, outcome, runtime, model, started_at, ended_at, desk_item_id)
       SELECT $1, org_id, $2, workstation_id, NULL, 'question', 'ended', 'reported', runtime, model, now(), now(), $3 FROM agents WHERE id=$2`,
      [randomUUID(), agentId, itemId],
    );
}

describe('a question loop belongs to the stage its questions were asked in', () => {
  it('files one bug while the card moves on through later stages', async () => {
    await designate();
    const card = await w.card({ title: 'Asking card' });
    await q('UPDATE cards SET stage=$2 WHERE id=$1', [card.id, 'build']);
    await askedItem(card.id, 5);
    await platformScan(ctx);
    for (const stage of ['pre_review', 'review']) {
      await q('UPDATE cards SET stage=$2 WHERE id=$1', [card.id, stage]);
      await platformScan(ctx);
    }
    const bugs = await bugRows();
    expect(bugs).toHaveLength(1);
    expect(bugs[0]!.signature).toMatch(/:build:questions$/);
    expect(bugs[0]!.diagnostics).toMatchObject({ kind: 'loop_questions', stage: 'build' });
  });
});

describe('stop-loss arbitrations', () => {
  it('do not count as the card asking', async () => {
    const card = await w.card({ title: 'Stop-loss card' });
    await askedItem(card.id, 5, 'stop_loss');
    await askedItem(card.id, 4);
    expect(await questionLoops(card.id)).toHaveLength(0);
    const { questionShiftCount } = await import('../src/commands/loop-breaker.ts');
    expect(await questionShiftCount(ctx.pool, card.id, new Date(Date.now() - 3600_000))).toBe(4);
    await askedItem(card.id, 1);
    const loops = await questionLoops(card.id);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.count).toBe(5);
  });
});
