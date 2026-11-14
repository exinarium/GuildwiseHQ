import { randomUUID } from 'node:crypto';
import { PR_LIST_CAPABILITY, PR_REVIEW_CAPABILITY } from '@aom/shared';
import type { FakeRunner } from './fake-runner.ts';
import { createWorld, ok, REPO_SSH, type World } from './world.ts';

export const HEAD = 'a'.repeat(40);
export const BASE = 'b'.repeat(40);

/** A PR-only world with one ready reviewer workstation, plus seeding and request helpers for the by-hand trigger tests. */
export async function manualWorld() {
  const w: World = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  const r: FakeRunner = await w.connectRunner({ capabilities: [PR_LIST_CAPABILITY, PR_REVIEW_CAPABILITY] });
  const db = () => w.t.app.ctx.pool;
  const ctx = () => w.t.app.ctx;
  await db().query(
    `UPDATE project_repos SET pr_only=true, pr_only_since='2030-01-01T00:00:00Z' WHERE id=$1`,
    [w.repoId],
  );
  r.send('repos.report', {
    repos: [
      { remoteUrl: REPO_SSH, localPath: '/tmp/toy', headBranch: 'main', reviewerToken: { present: true } },
    ],
  });
  await r.barrier();

  let seq = 0;
  const addPr = async (over: { state?: string; closed?: boolean; openedAt?: Date } = {}): Promise<string> => {
    const id = randomUUID();
    const n = 100 + seq++;
    const opened = over.openedAt ?? new Date(Date.now() - 3_600_000);
    await db().query(
      `INSERT INTO pr_reviews (id, project_id, project_repo_id, change_id, url, title, author, head_branch, base_branch,
                               opened_at, recorded_at, review_state, closed_at, changed_lines)
       VALUES ($1,$2,$3,$4,$5,$6,'dev',$7,'main',$8,$8,$9,$10,100)`,
      [
        id,
        w.projectId,
        w.repoId,
        String(n),
        `https://github.com/acme/toy/pull/${n}`,
        `Change ${n}`,
        `feature/${n}`,
        opened,
        over.state ?? 'not_reviewed',
        over.closed ? new Date() : null,
      ],
    );
    return id;
  };
  /** A run already finished (or running) for the PR, started `agoMin` minutes ago. */
  const addRun = async (
    prId: string,
    over: { state: string; agoMin?: number; trigger?: 'auto' | 'manual'; code?: string },
  ): Promise<string> => {
    const id = randomUUID();
    await db().query(
      `INSERT INTO pr_review_runs (id, pr_review_id, project_id, reviewer, runtime, model, workstation_id, state,
                                   timeout_ms, started_at, trigger, error_code)
       VALUES ($1,$2,$3,'first','claude-code','sonnet',$4,$5,600000,$6,$7,$8)`,
      [
        id,
        prId,
        w.projectId,
        w.workstationId,
        over.state,
        new Date(Date.now() - (over.agoMin ?? 30) * 60_000),
        over.trigger ?? 'auto',
        over.code ?? null,
      ],
    );
    await db().query('UPDATE pr_reviews SET last_run_id=$2 WHERE id=$1', [prId, id]);
    return id;
  };
  const owner = (method: string, url: string, body?: unknown) =>
    w.t.req(method, url, { cookie: w.owner.cookie, body });
  const trigger = (prId: string, body?: unknown, cookie = w.owner.cookie) =>
    w.t.req('POST', `/api/projects/${w.projectId}/pull-requests/${prId}/review`, { cookie, body });
  const list = async (cookie = w.owner.cookie): Promise<any[]> =>
    (await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}/pull-requests`, { cookie }))).pullRequests;
  const prOf = async (prId: string, cookie?: string) => (await list(cookie)).find((p) => p.id === prId);
  const runs = async (prId: string) =>
    (
      await db().query(
        `SELECT id, state, trigger, requested_by, rerun_of_run_id FROM pr_review_runs WHERE pr_review_id=$1 ORDER BY started_at`,
        [prId],
      )
    ).rows;
  const runCommands = async () =>
    (await db().query(`SELECT count(*)::int AS n FROM runner_commands WHERE type='pr_review.run'`)).rows[0]
      .n as number;
  const addMember = async (role: 'manager' | 'member' = 'manager') => {
    const u = await w.t.userSession(`member-${randomUUID().slice(0, 6)}@example.test`);
    await db().query(
      `INSERT INTO project_members (project_id, user_id, role, status, joined_at, direct, org_grant)
       VALUES ($1,$2,$3,'active',now(),true,false)`,
      [w.projectId, u.id, role],
    );
    return u;
  };
  const clean = async () => {
    await db().query('DELETE FROM pr_review_runs');
    await db().query('DELETE FROM pr_reviews');
    await db().query(`DELETE FROM runner_commands WHERE type LIKE 'pr_review.%'`);
    await db().query(`UPDATE workstations SET connected=true WHERE id=$1`, [w.workstationId]);
  };
  return { w, r, db, ctx, owner, trigger, list, prOf, runs, runCommands, addPr, addRun, addMember, clean };
}
