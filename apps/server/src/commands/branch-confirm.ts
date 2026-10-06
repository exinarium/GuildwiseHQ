import type { EventOf, WorkingBranchReason } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { StoredEvent } from '../eventstore/types.ts';
import { workingBranchQuestionEvents } from './hygiene.ts';

async function askForProject(
  ctx: Ctx,
  projectId: string,
  reason: WorkingBranchReason,
  because: string,
  phaseId?: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const project = await one(tx, `SELECT * FROM projects WHERE id=$1 AND status='active'`, [projectId]);
    if (!project) return;
    // Only repositories some workstation holds a clone of: that is where hygiene commits and pushes.
    const repos = await rows(
      tx,
      `SELECT r.* FROM project_repos r
        WHERE r.project_id=$1 AND r.removed_at IS NULL
          AND EXISTS (SELECT 1 FROM workstation_repos wr WHERE wr.project_repo_id = r.id) ORDER BY r.name`,
      [projectId],
    );
    // No re-ask timer (owner decision, 2026-10-06): every new intake or phase asks again, for repositories that have a
    // working branch (keep or change) and for those that have none yet (which one is it?).
    for (const repo of repos) {
      const events = await workingBranchQuestionEvents(ctx, tx, project, repo, {
        reason,
        because,
        ...(phaseId ? { phaseId } : {}),
      });
      if (events.length) await ctx.store.append(events, { tx });
    }
  });
}

/**
 * Re-confirm on change (owner decision 3): a new intake for a project, and a new phase created or activated, make the
 * DevOps engineer ask the manager whether the working branch stays or changes (or, with none yet, which it is). There is
 * no timer: only these two events ask. A phase that names its own working branch
 * needs no question. Runs after the event committed (the gateway's event reactions); failures are logged, never raised.
 */
export async function confirmBranchOnEvent(ctx: Ctx, e: StoredEvent): Promise<void> {
  try {
    switch (e.event.type) {
      case 'TicketMapped': {
        const p = (e.event as EventOf<'TicketMapped'>).payload;
        if (p.unmapped || !p.projectId || p.cardId) return;
        await askForProject(ctx, p.projectId, 'intake', 'a new intake');
        return;
      }
      case 'PhaseCreated': {
        const p = (e.event as EventOf<'PhaseCreated'>).payload;
        if (p.status !== 'open' || p.workingBranch) return;
        await askForProject(ctx, p.projectId, 'phase', `the new phase ${p.ref}`, p.phaseId);
        return;
      }
      case 'PhaseConfirmed': {
        const p = (e.event as EventOf<'PhaseConfirmed'>).payload;
        const phase = await one(ctx.pool, 'SELECT * FROM phases WHERE id=$1', [p.phaseId]);
        if (!phase || phase.working_branch) return;
        await askForProject(ctx, phase.project_id, 'phase', `the phase ${phase.ref}`, phase.id);
        return;
      }
      default:
        return;
    }
  } catch (err) {
    ctx.log.warn({ err, event: e.event.type }, 'could not ask for the working branch');
  }
}
