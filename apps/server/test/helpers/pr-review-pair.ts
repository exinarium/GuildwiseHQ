import { randomUUID } from 'node:crypto';
import { PR_LIST_CAPABILITY, PR_REVIEW_CAPABILITY, PR_REVIEW_PAIR_CAPABILITY } from '@aom/shared';
import type { FakeRunner } from './fake-runner.ts';
import { createWorld, ok, REPO_SSH, type World } from './world.ts';

/** Fixtures of the second-reviewer (Opus) tests: a PR-only repository with n open pull requests and a fake workstation. */
export const HEAD = 'a'.repeat(40);
export const BASE = 'b'.repeat(40);

export interface PairWorld {
  w: World;
  r: FakeRunner;
  db: () => World['t']['app']['ctx']['pool'];
  ctx: () => World['t']['app']['ctx'];
  owner: (method: string, url: string, body?: unknown) => ReturnType<World['t']['req']>;
  prIds: Record<string, string>;
  close: () => Promise<void>;
}

export async function createPairWorld(
  prCount: number,
  opts: { capabilities?: string[] } = {},
): Promise<PairWorld> {
  const w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  const r = await w.connectRunner({
    capabilities: opts.capabilities ?? [PR_LIST_CAPABILITY, PR_REVIEW_CAPABILITY, PR_REVIEW_PAIR_CAPABILITY],
  });
  const db = () => w.t.app.ctx.pool;
  const owner = (method: string, url: string, body?: unknown) =>
    w.t.req(method, url, { cookie: w.owner.cookie, body });
  const from = r.received.length;
  await ok(owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { prOnly: true }));
  const list: any = await r.waitFor('command', (f: any) => f.command === 'repo.list_prs', 5000, from);
  await r.barrier();
  const t0 = (await db().query('SELECT pr_only_since FROM project_repos WHERE id=$1', [w.repoId])).rows[0]
    .pr_only_since as Date;
  const pr = (n: number) => ({
    id: String(n),
    url: `https://github.com/acme/toy/pull/${n}`,
    title: `Change ${n}`,
    author: 'dev',
    head: `feature/${n}`,
    base: 'main',
    createdAt: new Date(t0.getTime() + n * 60_000).toISOString(),
  });
  r.send('command.result', {
    commandId: list.commandId,
    ok: true,
    result: { ok: true, complete: true, changes: Array.from({ length: prCount }, (_, i) => pr(i + 1)) },
  });
  await r.barrier();
  await w.t.app.ctx.notifier.flush();
  r.send('repos.report', {
    repos: [
      { remoteUrl: REPO_SSH, localPath: '/tmp/toy', headBranch: 'main', reviewerToken: { present: true } },
    ],
  });
  await r.barrier();
  const prIds: Record<string, string> = {};
  const res: any = await ok(owner('GET', `/api/projects/${w.projectId}/pull-requests`));
  for (const p of res.pullRequests) prIds[p.changeId] = p.id;
  return {
    w,
    r,
    db,
    ctx: () => w.t.app.ctx,
    owner,
    prIds,
    close: async () => {
      r.close();
      await w.t.close();
    },
  };
}

const reviewerResult = (reviewer: 'first' | 'second', label: string, model: string, prsReviewed: number) => ({
  reviewer,
  label,
  model,
  prsReviewed,
  prsNotReviewed: 20 - prsReviewed,
  wouldPost: 10,
  heldBack: 2,
  useful: 7,
  noise: 3,
  precision: 0.7,
  effortMs: 60_000,
});

/** A finished replay on the project's repository: the "recorded replay" that lets the owner switch the second reviewer on. */
export async function seedRecordedReplay(
  p: Pick<PairWorld, 'db' | 'w'>,
  prsReviewed: { first: number; second: number } = { first: 20, second: 20 },
): Promise<string> {
  const id = randomUUID();
  await p.db().query(
    `INSERT INTO pr_replays (id, project_id, project_repo_id, state, request_id, started_by, started_at, finished_at, result)
     VALUES ($1,$2,$3,'finished',$4,$5,now() - interval '1 hour',now(),$6)`,
    [
      id,
      p.w.projectId,
      p.w.repoId,
      randomUUID(),
      p.w.owner.id,
      JSON.stringify({
        prCount: 20,
        reviewers: [
          reviewerResult('first', 'Sonnet', 'sonnet', prsReviewed.first),
          reviewerResult('second', 'Opus', 'opus', prsReviewed.second),
        ],
        effort: {
          activeMs: 1,
          perPrMs: 1,
          perFindingMs: 1,
          findingsMarked: 10,
          wallClockMs: 1,
          idleCapMs: 1,
          prsPerWeek: 5,
          hoursPerWeekEstimate: 1,
        },
      }),
    ],
  );
  return id;
}

export const completedResult = (findings: unknown[], over: Record<string, unknown> = {}) => ({
  outcome: 'completed',
  headSha: HEAD,
  baseSha: BASE,
  durationMs: 120_000,
  summary: 'Model written summary.',
  findings,
  ...over,
});

export const finding = (over: Record<string, unknown> = {}) => ({
  path: 'src/a.ts',
  line: 12,
  severity: 'high',
  title: 'Null deref',
  body: 'x may be null here',
  anchored: true,
  ...over,
});
