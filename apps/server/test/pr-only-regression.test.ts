import { PR_LIST_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPrListResult, listReviewEligiblePrs, requestPrList } from '../src/commands/pr-only.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** AC4: a repository that is not PR-only is never asked for pull requests and an answer for it records nothing. */

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
const count = async (sql: string, params: unknown[]) => Number((await db().query(sql, params)).rows[0].n);

describe('a repository that is not PR-only behaves as before', () => {
  it('the scheduler pass sends no repo.list_prs and records no poll', async () => {
    const before = r.received.length;
    await w.t.app.ctx.services.scheduler.run();
    await r.barrier();
    expect(r.received.slice(before).filter((f: any) => f.command === 'repo.list_prs')).toHaveLength(0);
    expect(
      await count('SELECT count(*) AS n FROM pr_review_polls WHERE project_repo_id=$1', [w.repoId]),
    ).toBe(0);
    expect(await requestPrList(w.t.app.ctx, w.repoId)).toEqual({ queued: false, reason: 'skipped' });
  });

  it('a forged answer records nothing and starts no card', async () => {
    const cardsBefore = await count('SELECT count(*) AS n FROM cards WHERE project_id=$1', [w.projectId]);
    await applyPrListResult(
      w.t.app.ctx,
      { requestId: '00000000-0000-4000-8000-000000000001', repoId: w.repoId },
      true,
      {
        ok: true,
        complete: true,
        changes: [
          {
            id: '1',
            url: 'https://github.com/acme/toy/pull/1',
            title: 'x',
            author: null,
            head: 'feature/x',
            base: 'main',
            createdAt: new Date().toISOString(),
          },
        ],
      },
      undefined,
    );
    expect(await count('SELECT count(*) AS n FROM pr_reviews WHERE project_repo_id=$1', [w.repoId])).toBe(0);
    expect(await listReviewEligiblePrs(db(), w.projectId)).toEqual([]);
    expect(await count('SELECT count(*) AS n FROM cards WHERE project_id=$1', [w.projectId])).toBe(
      cardsBefore,
    );
  });

  it('the repository DTO says not PR-only and a card is still created the usual way', async () => {
    const repo = (await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: w.owner.cookie })))
      .repos[0];
    expect(repo).toMatchObject({ prOnly: false, prReview: null });
    const card = await w.card();
    expect(card.id).toBeTruthy();
    expect(await count('SELECT count(*) AS n FROM pr_reviews WHERE project_id=$1', [w.projectId])).toBe(0);
  });
});
