import { PR_LIST_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listReviewEligiblePrs, PENDING_MS, PR_POLL_MS } from '../src/commands/pr-only.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** PR-only review: open pull requests come from the runner's `repo.list_prs` answer (AC3) and stop when off (AC2). */

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [PR_LIST_CAPABILITY] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const db = () => w.t.app.ctx.pool;
const clock = () => w.t.app.ctx.clock as unknown as { advance(ms: number): void };
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const setPrOnly = (prOnly: boolean) =>
  ok(owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { prOnly }));
const since = async () =>
  (await db().query('SELECT pr_only_since FROM project_repos WHERE id=$1', [w.repoId])).rows[0]
    .pr_only_since as Date;
const reviews = async () =>
  (await db().query('SELECT * FROM pr_reviews WHERE project_repo_id=$1 ORDER BY change_id', [w.repoId])).rows;
const listCommands = (from = 0) => r.received.slice(from).filter((f: any) => f.command === 'repo.list_prs');
const nextListCommand = async (from: number) => {
  const c: any = await r.waitFor('command', (f: any) => f.command === 'repo.list_prs', 5000, from);
  await r.barrier();
  return c;
};
const change = (id: string, createdAt: Date, head = `feature/${id}`) => ({
  id,
  url: `https://github.com/acme/toy/pull/${id}`,
  title: `Change ${id}`,
  author: 'dev',
  head,
  base: 'main',
  createdAt: createdAt.toISOString(),
});
const answer = async (cmd: any, result: unknown) => {
  r.send('command.result', { commandId: cmd.commandId, ok: true, result });
  await r.barrier();
  await w.t.app.ctx.notifier.flush();
};
const repoDto = async () =>
  (await ok<any>(owner('GET', `/api/projects/${w.projectId}`))).repos.find((x: any) => x.id === w.repoId);

describe('PR-only review: pull requests opened after the switch are recorded as not reviewed', () => {
  it('AC3: a new PR is recorded once; old PRs and card branches are left out; a complete list closes it', async () => {
    const from = r.received.length;
    await setPrOnly(true);
    const cmd = await nextListCommand(from);
    expect(cmd.payload).toMatchObject({ repoId: w.repoId, remoteUrlNormalized: 'github.com/acme/toy' });

    const t0 = await since();
    const card = await w.card();
    await db().query(`UPDATE cards SET branch_name='aom/card-branch' WHERE id=$1`, [card.id]);
    const fresh = change('11', new Date(t0.getTime() + 60_000));
    await answer(cmd, {
      ok: true,
      complete: true,
      changes: [
        fresh,
        change('10', new Date(t0.getTime() - 60_000)),
        change('12', new Date(t0.getTime() + 60_000), 'aom/card-branch'),
      ],
    });
    const rows = await reviews();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      change_id: '11',
      review_state: 'not_reviewed',
      head_branch: 'feature/11',
      base_branch: 'main',
      closed_at: null,
    });
    const eligible = await listReviewEligiblePrs(db(), w.projectId);
    expect(eligible.map((p) => p.changeId)).toEqual(['11']);
    expect(await repoDto()).toMatchObject({ prOnly: true, prReview: { waiting: 1, problem: null } });

    // Throttled: no second request within five minutes.
    let before = r.received.length;
    await w.t.app.ctx.services.scheduler.run();
    await r.barrier();
    expect(listCommands(before)).toHaveLength(0);

    // The same answer again adds nothing.
    clock().advance(PR_POLL_MS + 1000);
    before = r.received.length;
    await w.t.app.ctx.services.scheduler.run();
    const again = await nextListCommand(before);
    await answer(again, { ok: true, complete: true, changes: [fresh] });
    expect(await reviews()).toHaveLength(1);

    // A complete list without it marks it closed; an incomplete one would not.
    clock().advance(PR_POLL_MS + 1000);
    before = r.received.length;
    await w.t.app.ctx.services.scheduler.run();
    const third = await nextListCommand(before);
    await answer(third, { ok: true, complete: true, changes: [] });
    await until(async () => (await reviews())[0]?.closed_at, 3000, 'closed');
    expect(await listReviewEligiblePrs(db(), w.projectId)).toEqual([]);
  });

  it('an unsupported git host is shown as the problem', async () => {
    clock().advance(PR_POLL_MS + 1000);
    const before = r.received.length;
    await w.t.app.ctx.services.scheduler.run();
    const cmd = await nextListCommand(before);
    await answer(cmd, { ok: false, reason: 'unsupported' });
    expect((await repoDto()).prReview).toMatchObject({ problem: 'unsupported' });
  });

  it('AC2: an answer arriving after the switch was turned off records nothing, and nothing more is asked', async () => {
    clock().advance(PR_POLL_MS + 1000);
    let before = r.received.length;
    await w.t.app.ctx.services.scheduler.run();
    const cmd = await nextListCommand(before);
    const t0 = await since();
    await setPrOnly(false);
    await answer(cmd, {
      ok: true,
      complete: true,
      changes: [change('20', new Date(t0.getTime() + 120_000))],
    });
    expect((await reviews()).map((x) => x.change_id)).not.toContain('20');
    expect(await listReviewEligiblePrs(db(), w.projectId)).toEqual([]);

    clock().advance(PR_POLL_MS + 1000);
    before = r.received.length;
    await w.t.app.ctx.services.scheduler.run();
    await r.barrier();
    expect(listCommands(before)).toHaveLength(0);
  });

  it('AC2: rows recorded while on are not eligible while the repository is off', async () => {
    const from = r.received.length;
    clock().advance(PR_POLL_MS + 1000);
    await setPrOnly(true);
    const cmd = await nextListCommand(from);
    const t0 = await since();
    await answer(cmd, { ok: true, complete: true, changes: [change('30', new Date(t0.getTime() + 1000))] });
    expect((await listReviewEligiblePrs(db(), w.projectId)).map((p) => p.changeId)).toEqual(['30']);
    await setPrOnly(false);
    expect(await listReviewEligiblePrs(db(), w.projectId)).toEqual([]);
  });

  it('an unanswered request is replaced, not piled up: at most one deliverable repo.list_prs per repository', async () => {
    const deliverable = async () =>
      (
        await db().query(
          `SELECT id, expires_at FROM runner_commands
            WHERE type='repo.list_prs' AND payload->>'repoId' = $1 AND status IN ('pending','sent')
              AND (expires_at IS NULL OR expires_at > $2)`,
          [w.repoId, w.t.app.ctx.clock.now()],
        )
      ).rows;
    const superseded = async () =>
      Number(
        (
          await db().query(
            `SELECT count(*) AS n FROM runner_commands
              WHERE type='repo.list_prs' AND payload->>'repoId' = $1 AND last_error='superseded'`,
            [w.repoId],
          )
        ).rows[0].n,
      );
    // The workstation stays paired but goes offline: nothing answers.
    await db().query('UPDATE workstations SET connected=false');
    try {
      clock().advance(PR_POLL_MS + 1000);
      const supersededBefore = await superseded();
      await setPrOnly(true);
      for (let i = 0; i < 3; i++) {
        clock().advance(PENDING_MS + 1000);
        await w.t.app.ctx.services.scheduler.run();
        await r.barrier();
        const live = await deliverable();
        expect(live).toHaveLength(1);
        // Each request expires with its pending window, so a long offline spell never builds a backlog.
        const expiresIn = new Date(live[0].expires_at).getTime() - w.t.app.ctx.clock.now().getTime();
        expect(expiresIn).toBeGreaterThan(0);
        expect(expiresIn).toBeLessThanOrEqual(PENDING_MS);
      }
      expect((await superseded()) - supersededBefore).toBeGreaterThanOrEqual(3);

      // Once expired, the request is never handed out again.
      clock().advance(PENDING_MS + 1000);
      expect(await deliverable()).toHaveLength(0);
    } finally {
      await db().query('UPDATE workstations SET connected=true');
      await setPrOnly(false);
    }
  });
});
