import { randomUUID } from 'node:crypto';
import {
  classifyDeployRisk,
  type DeployCheckRequest,
  type DeployDecision,
  PLATFORM_DESK_SUBKIND,
  type PlatformDeployAuditDto,
  type RecordDeployRequest,
  streamId,
} from '@aom/shared';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict } from '../errors.ts';
import { notifyPlatformDesk } from './desk.ts';
import { getPlatformTeam } from './settings.ts';

/**
 * Deploy policy and audit trail (Lean Team v3, design 8.4). This models the policy only: nothing here deploys anything.
 * A deploy script asks `checkDeploy` ("is this deploy allowed?") and, after deploying, calls `recordDeploy`.
 *
 *  - A fix goes live without anybody's consent when it passed review, tests and UAT and is not high risk and needs no
 *    downtime. When it fixes a bug that is pausing work, that is the whole point: the platform organisation is informed
 *    on its desk afterwards. The super admin's consent is never needed (they have no desk).
 *  - HIGH RISK (auth/permissions/secrets, data/migrations, tenancy/billing) is decided from path globs over the fix diff
 *    on the server (the caller's own claim is not taken) and needs the platform organisation's approval on its desk.
 *  - Downtime needs the platform organisation's explicit go-ahead.
 */

type ApprovalKind = 'high_risk' | 'downtime';

const SUBKIND: Record<ApprovalKind, string> = {
  high_risk: PLATFORM_DESK_SUBKIND.deployApproval,
  downtime: PLATFORM_DESK_SUBKIND.downtimeApproval,
};

async function ensureApproval(
  ctx: Ctx,
  tx: Tx,
  kind: ApprovalKind,
  req: DeployCheckRequest,
  risk: { categories: string[]; paths: string[] },
): Promise<{ id: string; status: string }> {
  const have = await one(
    tx,
    'SELECT id, status FROM platform_deploy_approvals WHERE version=$1 AND kind=$2',
    [req.version, kind],
  );
  if (have) return have as { id: string; status: string };
  const team = await getPlatformTeam(tx);
  const id = randomUUID();
  const deskItemId = randomUUID();
  const label = kind === 'high_risk' ? 'High-risk deploy' : 'Deploy with downtime';
  const body =
    kind === 'high_risk'
      ? `Version ${req.version}${req.fromVersion ? ` (from ${req.fromVersion})` : ''} changes ${risk.categories.join(', ').replaceAll('_', ' ')}.\n\nChanged files that make it high risk:\n${risk.paths
          .slice(0, 25)
          .map((p) => `- ${p}`)
          .join(
            '\n',
          )}${risk.paths.length > 25 ? `\n- and ${risk.paths.length - 25} more` : ''}\n\n${req.diffSummary ?? ''}\n\nApprove to let the deploy go ahead; reject to hold it. Rollback: ${req.rollbackPath ?? 'not given'}.`
      : `Version ${req.version}${req.fromVersion ? ` (from ${req.fromVersion})` : ''} needs the service down while it deploys.\n\n${req.diffSummary ?? ''}\n\nApprove to give the explicit go-ahead; reject to hold it. Rollback: ${req.rollbackPath ?? 'not given'}.`;
  await tx.query(
    `INSERT INTO platform_deploy_approvals (id, version, kind, desk_item_id, detail, requested_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [
      id,
      req.version,
      kind,
      team ? deskItemId : null,
      JSON.stringify({ risk, downtime: req.downtime, bugCardId: req.bugCardId ?? null }),
      ctx.clock.now(),
    ],
  );
  if (team)
    await ctx.store.append(
      [
        {
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'approval',
              subkind: SUBKIND[kind],
              title: `${label}: approve version ${req.version}?`,
              body,
              options: [],
              blocking: true,
              pinned: false,
              ...(req.bugCardId ? { cardId: req.bugCardId, projectId: team.projectId } : {}),
              affectedCardIds: [],
              askedBy: { kind: 'system' },
              data: { approvalId: id, version: req.version, kind, platformTeam: true },
              subjectKey: `platform_deploy_approval:${kind}:${req.version}`,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(team.orgId),
        },
      ],
      { tx },
    );
  return { id, status: 'pending' };
}

async function audit(
  ctx: Ctx,
  tx: Tx,
  a: {
    kind: 'check' | 'deploy' | 'approval' | 'rollback';
    req: Pick<
      DeployCheckRequest,
      'version' | 'fromVersion' | 'bugCardId' | 'downtime' | 'rollbackPath' | 'diffSummary'
    > &
      Partial<Pick<DeployCheckRequest, 'reviewApproved' | 'testsPassed' | 'uatPassed'>>;
    decision?: DeployDecision;
    risk?: { high: boolean; categories: string[]; paths: string[] };
    outcome?: string;
    approvedBy?: string | null;
    reason?: string;
    actor: string;
    at?: Date;
  },
): Promise<void> {
  const risk = a.risk ?? {
    high: a.decision?.risk === 'high',
    categories: a.decision?.riskCategories ?? [],
    paths: a.decision?.riskPaths ?? [],
  };
  await tx.query(
    `INSERT INTO platform_deploy_audit (at, kind, version, from_version, risk, risk_categories, risk_paths, downtime, allowed,
        outcome, bug_card_id, fixes_pausing, review_approved, tests_passed, uat_passed, approved_by, rollback_path,
        diff_summary, reason, actor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      a.at ?? ctx.clock.now(),
      a.kind,
      a.req.version,
      a.req.fromVersion ?? null,
      risk.high ? 'high' : 'low',
      risk.categories,
      risk.paths.slice(0, 200),
      a.req.downtime,
      a.decision?.allowed ?? null,
      a.outcome ?? null,
      a.req.bugCardId ?? null,
      a.decision?.fixesPausingBug ?? false,
      a.req.reviewApproved ?? null,
      a.req.testsPassed ?? null,
      a.req.uatPassed ?? null,
      a.approvedBy ?? null,
      a.req.rollbackPath ?? null,
      a.req.diffSummary ?? null,
      a.reason ?? a.decision?.reason ?? null,
      a.actor,
    ],
  );
}

/** The decision for a deploy (and the audit row of the check). Creates the approval requests it needs, once per version. */
export async function checkDeploy(
  ctx: Ctx,
  req: DeployCheckRequest,
  actor: string,
  opts: { audit?: boolean } = {},
): Promise<DeployDecision> {
  const risk = classifyDeployRisk(req.changedFiles);
  return withAppendTx(ctx.pool, async (tx) => {
    const team = await getPlatformTeam(tx);
    const missing: string[] = [];
    if (!req.reviewApproved) missing.push('review');
    if (!req.testsPassed) missing.push('tests');
    if (!req.uatPassed) missing.push('uat');
    const fixesPausingBug =
      !!req.bugCardId &&
      !!(await one(
        tx,
        'SELECT 1 AS x FROM platform_pauses WHERE bug_card_id=$1 AND resumed_at IS NULL LIMIT 1',
        [req.bugCardId],
      ));
    const pendingApprovalIds: string[] = [];
    const need: ApprovalKind[] = [
      ...(risk.high ? (['high_risk'] as const) : []),
      ...(req.downtime ? (['downtime'] as const) : []),
    ];
    let reason = '';
    for (const kind of need) {
      if (!team) {
        missing.push('no_platform_team');
        reason = 'No platform team is designated, so a high-risk or downtime deploy cannot be approved.';
        continue;
      }
      const a = await ensureApproval(ctx, tx, kind, req, risk);
      if (a.status === 'approved') continue;
      missing.push(kind === 'high_risk' ? 'high_risk_approval' : 'downtime_approval');
      if (a.status === 'pending') pendingApprovalIds.push(a.id);
      else
        reason = `The platform organization declined the ${kind.replace('_', '-')} approval for ${req.version}.`;
    }
    const allowed = missing.length === 0;
    if (!reason)
      reason = allowed
        ? fixesPausingBug && !risk.high && !req.downtime
          ? 'Allowed: the fix only unpauses current workflows (low risk, no downtime). The platform organization is informed.'
          : 'Allowed.'
        : `Missing: ${missing.join(', ')}.`;
    const decision: DeployDecision = {
      allowed,
      risk: risk.high ? 'high' : 'low',
      riskCategories: risk.categories,
      riskPaths: risk.paths,
      missing,
      pendingApprovalIds,
      fixesPausingBug,
      reason,
    };
    if (opts.audit !== false) await audit(ctx, tx, { kind: 'check', req, decision, risk, actor });
    return decision;
  });
}

const approvers = async (ctx: Ctx, tx: Tx, version: string): Promise<string | null> => {
  const r = await rows(
    tx,
    `SELECT u.display_name FROM platform_deploy_approvals a JOIN users u ON u.id = a.decided_by
      WHERE a.version=$1 AND a.status='approved'`,
    [version],
  );
  return r.length > 0 ? r.map((x) => x.display_name).join(', ') : null;
};

/**
 * Records what a deploy script did: the audit row, and a report on the platform organisation's desk (version, bug,
 * risk, who approved, rollback path). A deploy that the policy does not allow is refused (409) and the refusal is
 * audited; a rollback or a failed deploy is recorded as it happened.
 */
export async function recordDeploy(
  ctx: Ctx,
  req: RecordDeployRequest,
  actor: string,
): Promise<{ recorded: true; decision: DeployDecision }> {
  const outcome = req.outcome ?? 'deployed';
  const decision = await checkDeploy(ctx, req, actor, { audit: false });
  if (outcome === 'deployed' && !decision.allowed) {
    await withAppendTx(ctx.pool, (tx) =>
      audit(ctx, tx, {
        kind: 'deploy',
        req,
        decision,
        outcome: 'refused',
        actor,
        reason: `Refused: ${decision.reason}`,
      }),
    );
    throw conflict('deploy_not_allowed', decision.reason, decision);
  }
  const by = await withAppendTx(ctx.pool, async (tx) => {
    const approvedBy = await approvers(ctx, tx, req.version);
    await audit(ctx, tx, {
      kind: outcome === 'rolled_back' ? 'rollback' : 'deploy',
      req,
      decision,
      outcome,
      approvedBy,
      actor,
      ...(req.note ? { reason: req.note } : {}),
      ...(req.deployedAt ? { at: new Date(req.deployedAt) } : {}),
    });
    return approvedBy;
  });
  const card = req.bugCardId
    ? await one(ctx.pool, 'SELECT ref, title FROM cards WHERE id=$1', [req.bugCardId])
    : undefined;
  await notifyPlatformDesk(ctx, {
    subjectKey: `platform_deploy_report:${req.version}:${outcome}`,
    subkind: PLATFORM_DESK_SUBKIND.deployReport,
    title: `${outcome === 'deployed' ? 'Deployed' : outcome === 'rolled_back' ? 'Rolled back' : 'Deploy failed'}: ${req.version}`,
    body: [
      `Version ${req.version}${req.fromVersion ? ` (from ${req.fromVersion})` : ''}: ${outcome.replace('_', ' ')}.`,
      card ? `Bug fix: ${card.ref} ${card.title}.` : null,
      `Risk: ${decision.risk}${decision.riskCategories.length ? ` (${decision.riskCategories.join(', ').replaceAll('_', ' ')})` : ''}${req.downtime ? ', with downtime' : ''}.`,
      decision.fixesPausingBug && decision.risk === 'low' && !req.downtime
        ? 'It fixed a bug that was pausing work, so it went live without approval; check that the fix was right.'
        : null,
      `Review ${req.reviewApproved ? 'approved' : 'not recorded'}, tests ${req.testsPassed ? 'passed' : 'not recorded'}, UAT ${req.uatPassed ? 'passed' : 'not recorded'}.`,
      by ? `Approved by ${by}.` : 'No approval was needed.',
      `Rollback path: ${req.rollbackPath ?? 'not given'}.`,
      req.note ? `Note: ${req.note}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    data: { version: req.version, outcome },
    ...(req.bugCardId && (await getPlatformTeam(ctx.pool)) ? { cardId: req.bugCardId } : {}),
  });
  return { recorded: true, decision };
}

/** The platform organisation's decision on an approval item (desk `closeItem` hook). */
export async function resolveDeployApprovalIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  item: Row,
  resolution: 'approved' | 'rejected' | 'acknowledged' | 'dismissed',
  note?: string,
): Promise<void> {
  if (resolution === 'acknowledged')
    throw badRequest('wrong_resolution', 'a deploy approval is approved or rejected');
  const a = await one(tx, 'SELECT * FROM platform_deploy_approvals WHERE desk_item_id=$1 FOR UPDATE', [
    item.id,
  ]);
  if (!a || a.status !== 'pending') return;
  const status = resolution === 'approved' ? 'approved' : 'denied';
  await tx.query(
    'UPDATE platform_deploy_approvals SET status=$2, decided_at=$3, decided_by=$4, note=$5 WHERE id=$1',
    [a.id, status, ctx.clock.now(), user.id, note ?? null],
  );
  const who = await one(tx, 'SELECT display_name FROM users WHERE id=$1', [user.id]);
  await audit(ctx, tx, {
    kind: 'approval',
    req: { version: a.version, downtime: a.kind === 'downtime' },
    risk: {
      high: a.kind === 'high_risk',
      categories: a.detail?.risk?.categories ?? [],
      paths: a.detail?.risk?.paths ?? [],
    },
    outcome: status,
    approvedBy: status === 'approved' ? (who?.display_name ?? user.id) : null,
    reason: `${a.kind.replace('_', ' ')} approval ${status}${note ? `: ${note}` : ''}`,
    actor: who?.display_name ?? user.id,
  });
  ctx.services.dispatcher.trigger();
}

const auditDto = (r: Row): PlatformDeployAuditDto => ({
  id: Number(r.id),
  at: iso(r.at) as string,
  kind: r.kind,
  version: r.version,
  fromVersion: r.from_version,
  risk: r.risk,
  riskCategories: r.risk_categories,
  downtime: r.downtime,
  allowed: r.allowed,
  outcome: r.outcome,
  bugCardId: r.bug_card_id,
  approvedBy: r.approved_by,
  rollbackPath: r.rollback_path,
  reason: r.reason,
});

export async function listDeployAudit(ctx: Ctx, limit = 100): Promise<PlatformDeployAuditDto[]> {
  const list = await rows(
    ctx.pool,
    'SELECT * FROM platform_deploy_audit ORDER BY at DESC, id DESC LIMIT $1',
    [Math.min(Math.max(1, limit), 500)],
  );
  return list.map(auditDto);
}
