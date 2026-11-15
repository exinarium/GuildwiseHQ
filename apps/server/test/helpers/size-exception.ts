import { randomUUID } from 'node:crypto';
import { PR_NOTICE_CAPABILITY } from '@aom/shared';
import { type MockInstance, vi } from 'vitest';
import { applyPrListResult } from '../../src/commands/pr-only.ts';
import { requestSizeExceptionIn } from '../../src/commands/size-exception.ts';
import { withAppendTx } from '../../src/db/tx.ts';
import { manualWorld } from './pr-review-manual.ts';

export const REASON = 'The generated client is one change; splitting it would leave a broken build.';

/** A PR-only world with a size budget of 600 changed lines, for the size exception tests (needs the test database). */
export async function sizeExceptionWorld() {
  const m = await manualWorld();
  const db = () => m.db();
  await db().query(
    `UPDATE workstation_capabilities SET capabilities = capabilities || $2::text[] WHERE workstation_id=$1`,
    [m.w.workstationId, [PR_NOTICE_CAPABILITY]],
  );
  const orgId = (await db().query('SELECT org_id FROM projects WHERE id=$1', [m.w.projectId])).rows[0]
    .org_id as string;
  // the fake clock stands still at the instant given (the real clock does not tick under it), so edges can be tested exactly
  let frozen: MockInstance | undefined;
  const pin = (iso: string) => {
    frozen?.mockRestore();
    frozen = vi.spyOn(m.w.t.clock, 'now').mockReturnValue(new Date(iso));
  };
  const unpin = () => {
    frozen?.mockRestore();
    frozen = undefined;
  };
  const clean = async () => {
    await m.clean();
    await db().query('DELETE FROM pr_split_notices');
    await db().query('DELETE FROM pr_open_changes');
    await db().query('DELETE FROM pr_size_exceptions');
    await db().query('DELETE FROM owner_pending_timers');
    await db().query('DELETE FROM desk_follow_ups');
    await db().query(`DELETE FROM org_follow_up WHERE org_id=$1`, [orgId]);
    await db().query(`DELETE FROM desk_items WHERE project_id=$1`, [m.w.projectId]);
    await db().query('UPDATE users SET timezone=NULL WHERE id=$1', [m.w.owner.id]);
    await db().query(`UPDATE projects SET size_budget=600, size_unit='changed_lines' WHERE id=$1`, [
      m.w.projectId,
    ]);
    unpin();
    m.w.t.clock.setOffset(0);
  };
  /** The git host's answer to the repository's open pull request list, through the poll's own path. */
  async function poll(list: Array<{ n: number; head: string; base: string; lines: number | null }>) {
    const requestId = randomUUID();
    await db().query(
      `INSERT INTO pr_review_polls (project_repo_id, request_id, workstation_id, state, requested_at)
       VALUES ($1,$2,$3,'pending',now())
       ON CONFLICT (project_repo_id) DO UPDATE SET request_id=EXCLUDED.request_id, state='pending'`,
      [m.w.repoId, requestId, m.w.workstationId],
    );
    await applyPrListResult(
      m.ctx(),
      { requestId, repoId: m.w.repoId },
      true,
      {
        ok: true,
        complete: true,
        changes: list.map((c) => ({
          id: String(c.n),
          url: `https://github.com/acme/toy/pull/${c.n}`,
          title: `Change ${c.n}`,
          author: 'dev',
          head: c.head,
          base: c.base,
          createdAt: '2030-02-01T00:00:00.000Z',
          changedLines: c.lines,
          changedFiles: 3,
          crossRepo: false,
        })),
      },
      undefined,
    );
  }
  const prOf = async (n: number) =>
    (
      await db().query(
        `SELECT id, review_state, split_reason, closed_at FROM pr_reviews WHERE project_repo_id=$1 AND change_id=$2`,
        [m.w.repoId, String(n)],
      )
    ).rows[0] as { id: string; review_state: string; split_reason: string | null; closed_at: Date | null };
  /** An over-budget pull request that the size check already sent back, as the poll records it. */
  async function overBudgetPr(n = 301, lines = 900) {
    await poll([{ n, head: `big/${n}`, base: 'main', lines }]);
    const pr = await prOf(n);
    if (pr.review_state !== 'needs_split') throw new Error(`expected needs_split, got ${pr.review_state}`);
    return pr.id;
  }
  const request = (prRef: string, reason = REASON) =>
    withAppendTx(m.ctx().pool, (tx) =>
      requestSizeExceptionIn(m.ctx(), tx, {
        orgId,
        prRef,
        reason,
        by: { kind: 'agent', role: 'ceo' },
      }),
    );
  const row = async (id: string) =>
    (await db().query('SELECT * FROM pr_size_exceptions WHERE id=$1', [id])).rows[0];
  const deskItem = async (id: string) =>
    (await db().query('SELECT * FROM desk_items WHERE id=$1', [id])).rows[0];
  const resolve = (deskItemId: string, resolution: string, note?: string, cookie = m.w.owner.cookie) =>
    m.w.t.req('POST', `/api/desk/${deskItemId}/resolve`, {
      cookie,
      body: { resolution, ...(note ? { note } : {}) },
    });
  const notices = async () => (await db().query('SELECT * FROM pr_split_notices')).rows;
  const events = async (type: string) =>
    (await db().query(`SELECT * FROM events WHERE type=$1`, [type])).rows;
  return {
    m,
    orgId,
    pin,
    unpin,
    clean,
    poll,
    prOf,
    overBudgetPr,
    request,
    row,
    deskItem,
    resolve,
    notices,
    events,
  };
}
