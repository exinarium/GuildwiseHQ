import { randomUUID } from 'node:crypto';
import { branchName, getStage, streamId } from '@aom/shared';
import { loadWorkflowById } from '../catalogue/loader.ts';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { type AgentView, agentView, isCandidate } from './candidates.ts';

export interface WorktreeClaim {
  repoId: string;
  remoteUrlNormalized: string;
  baseBranch: string;
  branchName: string;
  worktreePath: string;
  homeWorkstationId: string;
  created: boolean;
}

export interface ClaimResult {
  cardId: string;
  agentId: string;
  workstationId: string;
  shiftId: string;
  claimId: string;
  stage: string;
  overflow: boolean;
  worktree: WorktreeClaim | null;
  rebase: boolean;
  maxShiftMinutes: number;
}

export interface ClaimArgs {
  cardId: string;
  agentId: string;
  expectedStage: string;
  overflow?: boolean;
}

/**
 * Exclusive claim (docs/ARCHITECTURE.md section 8.1). Runs under the global append lock; the conditional UPDATE is
 * the atomicity guarantee and does not depend on the lock. Returns null when the card was taken, moved or is not
 * (any longer) claimable by this agent. The caller sends `shift.start` after the transaction committed.
 */
export async function claim(ctx: Ctx, args: ClaimArgs): Promise<ClaimResult | null> {
  const overflow = args.overflow ?? false;
  return withAppendTx(ctx.pool, async (tx): Promise<ClaimResult | null> => {
    const a = await one(
      tx,
      `SELECT a.*, ws.runtimes, ws.connected FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
                 JOIN users wu ON wu.id = ws.user_id AND wu.status = 'active'
        WHERE a.id=$1 AND a.status='active' AND ws.status='active'`,
      [args.agentId],
    );
    if (!a) return null;
    const runtime = (a.runtimes as Array<{ id: string; capabilities: string[] }>).find(
      (r) => r.id === a.runtime,
    );
    const view: AgentView = agentView(a, runtime?.capabilities ?? []);
    if (!overflow) {
      const active = await one(
        tx,
        'SELECT count(*)::int AS n FROM cards WHERE claimed_by_agent_id=$1 AND claim_id IS NOT NULL',
        [a.id],
      );
      if (Number(active?.n) >= a.capacity) return null;
    }
    if (!(await isCandidate(tx, view, args.cardId))) return null;

    const now = ctx.clock.now();
    const claimId = randomUUID();
    const shiftId = randomUUID();
    const upd = await tx.query(
      `UPDATE cards SET claim_id=$5, claimed_by_agent_id=$2, claim_workstation_id=$3, claim_shift_id=$4,
              claimed_at=$6, lease_expires_at=$7, claim_overflow=$8, status='claimed', updated_at=$6
        WHERE id=$1 AND status='queued' AND claim_id IS NULL AND stage=$9
        RETURNING id`,
      [
        args.cardId,
        a.id,
        a.workstation_id,
        shiftId,
        claimId,
        now,
        new Date(now.getTime() + 3600_000),
        overflow,
        args.expectedStage,
      ],
    );
    if (upd.rowCount === 0) return null;

    const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [args.cardId])) as Record<string, any>;
    const wf = await loadWorkflowById(tx, card.workflow_version_id);
    const stage = wf ? getStage(wf.definition, card.stage) : undefined;
    const project = (await one(tx, 'SELECT * FROM projects WHERE id=$1', [card.project_id])) as Record<
      string,
      any
    >;

    let worktree: WorktreeClaim | null = null;
    if (stage && stage.worktree !== 'none' && card.repo_id) {
      const wcard = card.worktree_card_id
        ? ((await one(tx, 'SELECT * FROM cards WHERE id=$1', [card.worktree_card_id])) as Record<string, any>)
        : card;
      const repo = (await one(tx, 'SELECT * FROM project_repos WHERE id=$1', [card.repo_id])) as Record<
        string,
        any
      >;
      const path: string | null = wcard.worktree_path ?? null;
      worktree = {
        repoId: repo.id,
        remoteUrlNormalized: repo.remote_url_normalized,
        // Suite cards run on the branch the completion action produced (pushed card branch), else the working branch.
        baseBranch:
          (path === null && typeof card.fields?.suiteBranch === 'string' && card.fields.suiteBranch) ||
          repo.working_branch ||
          project.working_branch,
        branchName: wcard.branch_name ?? branchName(project.branch_prefix, wcard.ref, wcard.title),
        worktreePath: path ?? '',
        homeWorkstationId: wcard.home_workstation_id ?? a.workstation_id,
        created: path === null,
      };
    }

    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'CardClaimed',
            payload: {
              cardId: card.id,
              claimId,
              agentId: a.id,
              workstationId: a.workstation_id,
              shiftId,
              stage: card.stage,
              overflow,
              worktree: worktree && {
                repoId: worktree.repoId,
                baseBranch: worktree.baseBranch,
                branchName: worktree.branchName,
                worktreePath: worktree.worktreePath,
                homeWorkstationId: worktree.homeWorkstationId,
                created: worktree.created,
              },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(card.org_id, card.project_id),
        },
      ],
      { tx },
    );
    return {
      cardId: card.id,
      agentId: a.id,
      workstationId: a.workstation_id,
      shiftId,
      claimId,
      stage: card.stage,
      overflow,
      worktree,
      rebase: stage?.rebaseBefore ?? false,
      maxShiftMinutes: stage?.maxShiftMinutes ?? 60,
    };
  });
}
