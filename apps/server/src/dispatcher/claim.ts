import { randomUUID } from 'node:crypto';
import { cardBranchName, getStage, MAIN_ACCOUNT, MENTION_WORK_HOLD_MS, streamId } from '@aom/shared';
import { loadWorkflowById } from '../catalogue/loader.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { cardUsage, limitReached, stopLossBudget, stopLossEvents } from '../commands/stop-loss.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { agentCapBlocked } from '../provider-keys/caps.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';
import { type AgentView, agentView, isCandidate } from './candidates.ts';
import { dependencyStates } from './dependencies.ts';

/** How long the first builder of a group keeps the rest of it after its last build claim (hard clause, renewed on every claim). */
export const GROUP_BUILDER_HOURS = 24;

export interface WorktreeClaim {
  repoId: string;
  remoteUrlNormalized: string;
  baseBranch: string;
  branchName: string;
  worktreePath: string;
  homeWorkstationId: string;
  created: boolean;
  /** No card branch yet (the dependencies have not landed): a read-only checkout of the working branch for the design. */
  readOnly?: boolean;
  /** The repository's main branch, when the owner named one (a missing working branch is created from it). */
  mainBranch?: string;
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
  /** Merge the latest main branch first (before the worktree is created): see `ShiftStart.prepare.syncMain`. */
  syncMain?: { mainBranch?: string; workingBranch: string };
  maxShiftMinutes: number;
  /** The Claude account the shift runs on; absent = main (docs/design/claude-accounts.md). */
  accountKey?: string;
}

export interface ClaimArgs {
  cardId: string;
  agentId: string;
  expectedStage: string;
  overflow?: boolean;
  /** The Claude account chosen for this shift (`main` or absent: the workstation's main account). */
  accountKey?: string;
}

/**
 * `name`, or `name-2`, `name-3`, ... : the first that no other card of the project uses as its branch (case-insensitive,
 * any status: finished branches can stay in the clone). The runner reuses an existing branch silently, so two cards from
 * the same ticket must never get the same name.
 */
export async function uniqueCardBranch(
  db: Queryable,
  projectId: string,
  cardId: string,
  name: string,
): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    const taken = await one(
      db,
      'SELECT 1 FROM cards WHERE project_id=$1 AND id<>$2 AND lower(branch_name)=lower($3) LIMIT 1',
      [projectId, cardId, candidate],
    );
    if (!taken) return candidate;
  }
}

/**
 * The branch of a card that has none yet: named by its work reference (cardBranchName), a ticket name made unique among
 * the project's cards. `fallbackReason`: the card's ticket could not be used, the name uses the internal ref.
 */
export async function newCardBranch(
  db: Queryable,
  prefix: string,
  card: { id: string; project_id: string; ref: string; title: string; fields?: unknown },
): Promise<{ name: string; fallbackReason?: string }> {
  const b = cardBranchName(prefix ?? '', card);
  if (!b.fromTicket)
    return b.fallbackReason ? { name: b.name, fallbackReason: b.fallbackReason } : { name: b.name };
  return { name: await uniqueCardBranch(db, card.project_id, card.id, b.name) };
}

/**
 * Exclusive claim (docs/ARCHITECTURE.md section 8.1). Runs under the global append lock; the conditional UPDATE is
 * the atomicity guarantee and does not depend on the lock. Returns null when the card was taken, moved or is not
 * (any longer) claimable by this agent. The caller sends `shift.start` after the transaction committed.
 */
export async function claim(ctx: Ctx, args: ClaimArgs): Promise<ClaimResult | null> {
  const overflow = args.overflow ?? false;
  const accountKey = args.accountKey && args.accountKey !== MAIN_ACCOUNT ? args.accountKey : undefined;
  return withAppendTx(ctx.pool, async (tx): Promise<ClaimResult | null> => {
    const a = await one(
      tx,
      `SELECT a.*, ws.runtimes, ws.connected FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
                 JOIN users wu ON wu.id = ws.user_id AND wu.status = 'active'
        WHERE a.id=$1 AND a.status='active' AND ws.status='active' AND ${wsServesOrgSql('ws', 'a.org_id')}`,
      [args.agentId],
    );
    if (!a) return null;
    const runtime = (a.runtimes as Array<{ id: string; capabilities: string[] }>).find(
      (r) => r.id === a.runtime,
    );
    const view: AgentView = agentView(a, runtime?.capabilities ?? []);
    // The last guard (the overflow and preferred paths do not come through the dispatcher's agent list): no claim for an agent
    // whose model would spend the organization's key of a provider whose monthly cap is reached.
    if (await agentCapBlocked(tx, a as never, ctx.clock.now(), undefined, accountKey)) return null;
    if (!overflow) {
      const active = await one(
        tx,
        'SELECT count(*)::int AS n FROM cards WHERE claimed_by_agent_id=$1 AND claim_id IS NOT NULL',
        [a.id],
      );
      if (Number(active?.n) >= a.capacity) return null;
    }
    if (!(await isCandidate(tx, view, args.cardId, ctx.clock.now()))) return null;
    // An agent is working in this card's folder from a comment (@mention): the card waits for the next pass.
    if (
      await one(
        tx,
        `SELECT 1 FROM card_mentions WHERE card_id=$1 AND work AND status='running' AND created_at > $2 LIMIT 1`,
        [args.cardId, new Date(ctx.clock.now().getTime() - MENTION_WORK_HOLD_MS)],
      )
    )
      return null;
    // Stop-loss on shifts: a card that used its shift budget is parked for its architect instead of going round again.
    {
      const row = await one(tx, 'SELECT * FROM cards WHERE id=$1', [args.cardId]);
      if (row?.status === 'queued') {
        const usage = await cardUsage(tx, row.id);
        const budget = await stopLossBudget(tx, row);
        const limit = limitReached(usage, budget);
        if (limit) {
          const parked = await stopLossEvents(ctx, tx, row, limit, usage, budget);
          if (parked.length > 0) await ctx.store.append(parked, { tx });
          return null;
        }
      }
    }

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
    let syncMain: ClaimResult['syncMain'];
    let branchFallback: { reason: string; name: string; ref: string } | undefined;
    // Planning (lean team) has no worktree of its own but reads the code: a read-only checkout of the working branch.
    if (stage && (stage.worktree !== 'none' || stage.id === 'planning') && card.repo_id) {
      const wcard = card.worktree_card_id
        ? ((await one(tx, 'SELECT * FROM cards WHERE id=$1', [card.worktree_card_id])) as Record<string, any>)
        : card;
      const repo = (await one(tx, 'SELECT * FROM project_repos WHERE id=$1', [card.repo_id])) as Record<
        string,
        any
      >;
      const path: string | null = wcard.worktree_path ?? null;
      // A card that already has a branch keeps it (in-flight cards are never renamed).
      const fresh = wcard.branch_name
        ? null
        : await newCardBranch(tx, project.branch_prefix, wcard as Parameters<typeof newCardBranch>[2]);
      branchFallback = fresh?.fallbackReason
        ? { reason: fresh.fallbackReason, name: fresh.name, ref: wcard.ref as string }
        : undefined;
      worktree = {
        repoId: repo.id,
        remoteUrlNormalized: repo.remote_url_normalized,
        // Suite cards run on the branch the completion action produced (pushed card branch), else the working branch.
        baseBranch:
          (path === null && typeof card.fields?.suiteBranch === 'string' && card.fields.suiteBranch) ||
          repo.working_branch ||
          project.working_branch,
        branchName: wcard.branch_name ?? (fresh?.name as string),
        worktreePath: path ?? '',
        homeWorkstationId: wcard.home_workstation_id ?? a.workstation_id,
        created: path === null,
        ...(repo.main_branch ? { mainBranch: repo.main_branch } : {}),
      };
      // The architect designing before the dependencies landed (backlog #80): no card branch, only a read-only checkout.
      if (
        path === null &&
        !card.worktree_card_id &&
        !card.investigation_only &&
        String(card.stage).startsWith('investigate') &&
        (await dependencyStates(tx, card.id)).some((d) => !d.landed)
      )
        worktree.readOnly = true;
      if (stage.id === 'planning' && path === null && !card.worktree_card_id) worktree.readOnly = true;
      // Merge the latest main first: only when the card's worktree is created now (never on reuse), never for a card that
      // works in another card's worktree (bug children), and not when the main branch is the working branch.
      const mergeMain = card.merge_main_first ?? project.merge_main_first ?? true;
      if (
        stage.syncMainBefore &&
        mergeMain &&
        worktree.created &&
        !worktree.readOnly &&
        !card.worktree_card_id &&
        repo.main_branch !== worktree.baseBranch
      )
        syncMain = {
          ...(repo.main_branch ? { mainBranch: repo.main_branch as string } : {}),
          workingBranch: worktree.baseBranch,
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
              ...(accountKey ? { accountKey } : {}),
              worktree:
                worktree && !worktree.readOnly
                  ? {
                      repoId: worktree.repoId,
                      baseBranch: worktree.baseBranch,
                      branchName: worktree.branchName,
                      worktreePath: worktree.worktreePath,
                      homeWorkstationId: worktree.homeWorkstationId,
                      created: worktree.created,
                    }
                  : null,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(card.org_id, card.project_id),
        },
        // lean team: the first builder of a group keeps the rest of the group (each build claim of a group card renews it).
        // A tester working a tests-only card's build stage (`aom design --tests-only`) never becomes the group builder.
        ...(card.group_id && stage?.claimRole === 'builder' && a.role_key === 'builder'
          ? [
              {
                streamId: streamId.project(card.project_id),
                event: {
                  type: 'GroupBuilderAssigned' as const,
                  payload: {
                    projectId: card.project_id,
                    groupId: card.group_id,
                    agentId: a.id,
                    cardId: card.id,
                    until: new Date(now.getTime() + GROUP_BUILDER_HOURS * 3600_000).toISOString(),
                  },
                },
                actor: SYSTEM_ACTOR,
                scope: projectScope(card.org_id, card.project_id),
              },
            ]
          : []),
        // The card's ticket could not name the branch: say so once, when the branch is created.
        ...(branchFallback && worktree?.created && !worktree.readOnly
          ? [
              cardMessage(
                card,
                { kind: 'system' },
                'system',
                `${branchFallback.reason}; the branch uses ${branchFallback.ref} instead: ${branchFallback.name}.`,
              ),
            ]
          : []),
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
      ...(syncMain ? { syncMain } : {}),
      maxShiftMinutes: stage?.maxShiftMinutes ?? 60,
      ...(accountKey ? { accountKey } : {}),
    };
  });
}
