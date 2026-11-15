import { type CeoActionName, SizeExceptionParamsSchema, type SizeExceptionParams } from '@aom/shared';
import { withAppendTx } from '../db/tx.ts';
import { requestSizeExceptionIn } from '../commands/size-exception.ts';
import { one } from '../db/sql.ts';
import { ceoBy, refuse, truncate } from './actions.ts';
import type { ActionDef } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `size-exception`: ask the owner to let an over-budget pull request stay as one. `--text` is the reason the owner reads
 * (at least 20 characters, checked by the schema and again by the command); `--reason` stays the CEO's own audit. The owner
 * decides on the Desk; with no answer in 2 working days the pull request goes back to its author and nobody is reminded.
 */
const sizeException: ActionDef<SizeExceptionParams> = {
  cls: 'pr.request_size_exception',
  schema: SizeExceptionParamsSchema,
  auditRefusals: true,
  describe: (p, pr) => `Ask the owner for a size exception on ${pr.subjectLabel}: ${truncate(p.text, 80)}`,
  async prepare(env, p) {
    const pr = await one(
      env.ctx.pool,
      `SELECT pr.id, pr.change_id, pr.review_state, pr.closed_at FROM pr_reviews pr
         JOIN projects p ON p.id = pr.project_id
        WHERE p.org_id=$1 AND ${UUID.test(p.pr) ? 'pr.id=$2::uuid' : 'pr.url=$2'}
        ORDER BY (pr.closed_at IS NULL) DESC LIMIT 1`,
      [env.orgId, p.pr],
    );
    if (!pr) return refuse(`pull request ${p.pr} not found in this organization`);
    const base = { subjectKind: 'pull_request', subjectId: pr.id as string, subjectLabel: `PR #${pr.change_id}` };
    if (pr.closed_at) return { ...base, refuse: 'the pull request is closed' };
    if (pr.review_state === 'size_exception_pending')
      return { ...base, refuse: 'a size exception request for this pull request is already open' };
    if (pr.review_state !== 'needs_split')
      return { ...base, refuse: 'only a pull request sent back for its size can have a size exception' };
    return base;
  },
  async execute(env, p) {
    const r = await withAppendTx(env.ctx.pool, (tx) =>
      requestSizeExceptionIn(env.ctx, tx, {
        orgId: env.orgId,
        prRef: p.pr,
        reason: p.text,
        by: ceoBy(env),
        agentId: env.agentId,
      }),
    );
    return {
      message: `Asked the owner (desk item ${r.deskItemId}); it lapses ${r.dueAt.toISOString()} if unanswered`,
      result: { ...r, dueAt: r.dueAt.toISOString() },
    };
  },
};

export const ACTIONS8: Partial<Record<CeoActionName, ActionDef>> = {
  'size-exception': sizeException,
};
