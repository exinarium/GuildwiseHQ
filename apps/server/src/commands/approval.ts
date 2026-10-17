import { randomUUID } from 'node:crypto';
import {
  type ApprovalApproveRequest,
  type ApprovalReviewInfo,
  type ApprovalSendBackRequest,
  type Approver,
  type CardApproval,
  type CardDiffResponse,
  DESK_SUBKIND,
  getStage,
  isOrgManager,
  isProjectOwner,
  OWNER_APPROVAL_REASON_TEXT,
  type OwnerApprovalReason,
  resolveOutcome,
  type Stage,
  streamId,
} from '@aom/shared';
import { orgOwnerId, orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard } from '../authz/scope.ts';
import { loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { workflowView } from './cards.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { qaOpenEvents } from './qa.ts';
import { qaAssignee } from './qa-flow.ts';

/**
 * Approval steps (backlog #16): a workflow step of kind `human` with `purpose: 'approval'`. A card that reaches it waits for
 * one person on the desk; they approve (the card goes to the next step) or send it back with a required comment (it goes
 * to the earlier step the step's `send_back` route names, as rework). The Owner and Admins of the organization and the
 * project owner may always act for the approver. Entry is found by a sweep of the event log (`enterHumanStep`, called by
 * the workflow reactor), so every way a card can reach the step opens it.
 */

const APPROVAL_OPTIONS = [
  { id: 'approve', label: 'Approve', description: 'Let the card go on.' },
  {
    id: 'send_back',
    label: 'Send back',
    description: 'Not good enough: send it back to the earlier step with a comment.',
  },
];

export interface ApprovalDoc {
  state: 'open' | 'approved' | 'sent_back';
  stageId: string;
  approverUserId: string;
  approverKind: 'org_owner' | 'project_owner' | 'starter' | 'member';
  fellBack?: boolean;
  openedAt: string;
  deskItemId: string | null;
  entrySeq: string | null;
  /** code-v6: the commit the approver is shown; the approval is for it and lapses when the branch moves. */
  sha?: string | null;
  decision: { kind: 'approved' | 'sent_back'; by: string; note: string | null; at: string } | null;
  sentBackCount?: number;
  lastSendBack?: { by: string; comment: string; at: string };
}

export const isApprovalStage = (
  stage: Stage | undefined,
): stage is Stage & { human: NonNullable<Stage['human']> } =>
  stage?.kind === 'human' && stage.human?.purpose === 'approval';

const activeMember = async (db: Queryable, projectId: string, userId: string): Promise<boolean> =>
  !!(await one(
    db,
    `SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id=$1 AND pm.user_id=$2 AND pm.status='active' AND u.status='active'`,
    [projectId, userId],
  ));

/** Who is asked: the step's approver, the Owner when that person is not available. */
export async function resolveApprover(
  db: Queryable,
  card: Row,
  cfg: Approver,
): Promise<{ userId: string; kind: ApprovalDoc['approverKind']; fellBack: boolean }> {
  const owner = await orgOwnerId(db, card.org_id);
  const projectOwner = async () =>
    (
      await one(
        db,
        `SELECT pm.user_id FROM project_members pm JOIN users u ON u.id = pm.user_id
          WHERE pm.project_id=$1 AND pm.role='owner' AND pm.status='active' AND u.status='active'
          ORDER BY (pm.org_grant IS NOT TRUE) DESC, pm.joined_at NULLS LAST, pm.user_id LIMIT 1`,
        [card.project_id],
      )
    )?.user_id as string | undefined;
  switch (cfg.kind) {
    case 'org_owner':
      return { userId: owner, kind: 'org_owner', fellBack: false };
    case 'project_owner': {
      const u = await projectOwner();
      return u
        ? { userId: u, kind: 'project_owner', fellBack: false }
        : { userId: owner, kind: 'project_owner', fellBack: true };
    }
    case 'starter': {
      const starter = await one(
        db,
        `SELECT i.started_by FROM intake_cards ic JOIN intakes i ON i.id = ic.intake_id
          WHERE ic.card_id=$1 ORDER BY ic.created_at LIMIT 1`,
        [card.id],
      );
      for (const id of [starter?.started_by, card.owner_user_id])
        if (id && (await activeMember(db, card.project_id, id)))
          return { userId: id, kind: 'starter', fellBack: false };
      return { userId: owner, kind: 'starter', fellBack: true };
    }
    case 'member':
      return (await activeMember(db, card.project_id, cfg.userId))
        ? { userId: cfg.userId, kind: 'member', fellBack: false }
        : { userId: owner, kind: 'member', fellBack: true };
  }
}

const nameOf = async (db: Queryable, userId: string): Promise<string> =>
  (await one(db, 'SELECT display_name FROM users WHERE id=$1', [userId]))?.display_name ?? 'someone';

/** May this user decide on the card's approval step? The approver, the project owner, the organization's Owner and Admins. */
export async function mayDecide(
  db: Queryable,
  user: { id: string },
  card: Row,
  projectRole: 'owner' | 'manager' | null | undefined,
): Promise<boolean> {
  const ap = card.approval as ApprovalDoc | null;
  if (!ap) return false;
  if (ap.approverUserId === user.id) return true;
  if (isProjectOwner(projectRole ?? null)) return true;
  return isOrgManager({ orgRole: await orgRoleOf(db, user.id, card.org_id) });
}

function deskQuestion(card: Row, stage: Stage, approverUserId: string, deskItemId: string): AppendInput {
  return {
    streamId: streamId.desk(deskItemId),
    event: {
      type: 'QuestionRaised',
      payload: {
        deskItemId,
        cardId: card.id,
        projectId: card.project_id,
        askedBy: { kind: 'system' },
        doing: `${card.ref} is waiting for your approval at "${stage.label}".`,
        question: `Approve ${card.ref}: ${card.title}`,
        options: APPROVAL_OPTIONS,
        recommendation: 'approve',
        blocking: false,
        routedTo: 'manager',
        dedupLedgerIds: [],
        affectedCardIds: [card.id],
        pinned: false,
        subkind: DESK_SUBKIND.approvalStep,
        addresseeUserId: approverUserId,
        data: { cardId: card.id, cardRef: card.ref, stageId: stage.id },
      },
    },
    actor: SYSTEM_ACTOR,
    scope: projectScope(card.org_id, card.project_id),
  };
}

// ------------------------------------------------------------------------------------------------ entry

/**
 * A card sits at a person's step (`human` stage): open it when it is not open yet. Approval steps ask the approver on the
 * desk. QA steps of custom workflows (the built-in QA is opened when the card is finalized) open manual QA the same way.
 * Idempotent: decided from the projected state under the card's row lock, once per entry into the step.
 */
export async function enterHumanStep(ctx: Ctx, cardId: string): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [cardId]);
    if (!card || !['queued', 'waiting'].includes(card.status) || card.claim_id) return false;
    const wf = await loadWorkflowById(tx, card.workflow_version_id);
    const stage = wf ? getStage(wf.definition, card.stage) : undefined;
    if (!stage || stage.kind !== 'human' || !stage.human) return false;

    const entry = await one<{ event_seq: string }>(
      tx,
      `SELECT event_seq FROM card_transitions
        WHERE card_id=$1 AND to_stage=$2 AND from_stage IS DISTINCT FROM to_stage ORDER BY id DESC LIMIT 1`,
      [card.id, card.stage],
    );
    const entrySeq = entry ? String(entry.event_seq) : null;

    if (stage.human.purpose === 'qa') {
      // The built-in QA opens with `CardFinalized`; this is for a custom workflow's QA step.
      const qa = card.qa as { state?: string } | null;
      if (qa && (qa.state === 'open' || qa.state === 'steps')) return false;
      const assignee = await qaAssignee(tx, card);
      if (!assignee) return false;
      await ctx.store.append(
        qaOpenEvents(card, assignee, stage.id, await nameOf(tx, assignee.userId), stage.label),
        { tx },
      );
      return true;
    }

    const ap = card.approval as ApprovalDoc | null;
    if (ap && ap.stageId === card.stage) {
      if (ap.state === 'open') return false; // already asked
      if (ap.entrySeq !== null && entrySeq !== null && ap.entrySeq === entrySeq) return false; // decided for this entry
    }
    const approver = await resolveApprover(tx, card, stage.human.approver ?? { kind: 'org_owner' });
    const deskItemId = randomUUID();
    const who = await nameOf(tx, approver.userId);
    const scope = projectScope(card.org_id, card.project_id);
    await ctx.store.append(
      [
        deskQuestion(card, stage, approver.userId, deskItemId),
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'ApprovalRequested',
            payload: {
              cardId: card.id,
              stageId: stage.id,
              approverUserId: approver.userId,
              approverKind: approver.kind,
              ...(approver.fellBack ? { fellBack: true } : {}),
              deskItemId,
              ...(entrySeq ? { entrySeq } : {}),
              ...(card.head_sha ? { sha: card.head_sha as string } : {}),
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `${card.ref} waits at "${stage.label}": ${who} approves or sends it back.${
            approver.fellBack ? ' The step names someone who is not available, so the Owner was asked.' : ''
          }`,
          { approval: 'requested', approverUserId: approver.userId },
        ),
      ],
      { tx },
    );
    return true;
  });
}

// ----------------------------------------------------------------------------------------------- actions

async function lockApprovalCard(
  tx: Tx,
  user: AuthSession['user'],
  idOrRef: string,
): Promise<{
  card: Row;
  ap: ApprovalDoc;
  stage: Stage;
  def: NonNullable<Awaited<ReturnType<typeof loadWorkflowById>>>;
}> {
  const visible = await loadVisibleCard(tx, user.id, idOrRef);
  const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [visible.card.id])) as Row;
  const ap = card.approval as ApprovalDoc | null;
  const wf = await loadWorkflowById(tx, card.workflow_version_id);
  const stage = wf ? getStage(wf.definition, card.stage) : undefined;
  if (!wf || !ap || ap.state !== 'open' || !isApprovalStage(stage) || ap.stageId !== card.stage)
    throw conflict('not_awaiting_approval', `${card.ref} is not waiting for an approval`);
  if (!(await mayDecide(tx, user, card, visible.role)))
    throw forbidden(
      'only the approver, the project owner or the organization Owner and Admins can decide this',
    );
  return { card, ap, stage, def: wf };
}

function resolveDeskEvent(
  card: Row,
  ap: ApprovalDoc,
  by: string,
  resolution: 'approved' | 'rejected',
  text: string,
): AppendInput[] {
  if (!ap.deskItemId) return [];
  return [
    {
      streamId: streamId.desk(ap.deskItemId),
      event: {
        type: 'DeskItemResolved',
        payload: {
          deskItemId: ap.deskItemId,
          resolution,
          note: text,
          by: { kind: 'user', userId: by },
        },
      },
      actor: userActor(by),
      scope: projectScope(card.org_id, card.project_id),
    },
  ];
}

async function decide(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  kind: 'approved' | 'sent_back',
  text: string | undefined,
): Promise<'stale' | undefined> {
  const stale = await withAppendTx(ctx.pool, async (tx): Promise<'stale' | undefined> => {
    const { card, ap, stage, def } = await lockApprovalCard(tx, user, idOrRef);
    // code-v6: an approval is for the commit whose diff was shown. When the branch moved since, nothing is approved: the
    // card is asked again for the commit it is at now (the same desk item) and the approver reads the new diff first.
    if (kind === 'approved' && ap.sha && card.head_sha && ap.sha !== card.head_sha && ap.deskItemId) {
      await ctx.store.append(
        [
          {
            streamId: streamId.card(card.id),
            event: {
              type: 'ApprovalRequested',
              payload: {
                cardId: card.id,
                stageId: stage.id,
                approverUserId: ap.approverUserId,
                approverKind: ap.approverKind,
                deskItemId: ap.deskItemId,
                ...(ap.entrySeq ? { entrySeq: ap.entrySeq } : {}),
                sha: card.head_sha as string,
              },
            },
            actor: SYSTEM_ACTOR,
            scope: projectScope(card.org_id, card.project_id),
          },
          cardMessage(
            card,
            { kind: 'system' },
            'system',
            `The code of ${card.ref} changed after the diff was shown (${String(ap.sha).slice(0, 10)} to ${String(card.head_sha).slice(0, 10)}): the approval was not taken. Read the new diff and approve again.`,
          ),
        ],
        { tx },
      );
      return 'stale';
    }
    const outcomeId = kind === 'approved' ? 'approve' : 'send_back';
    let toStage: string;
    try {
      toStage = resolveOutcome(def.definition, workflowView(card), stage.id, outcomeId).toStage;
    } catch {
      throw conflict('no_route', `step "${stage.label}" has no route for this decision`);
    }
    const scope = projectScope(card.org_id, card.project_id);
    const who = await nameOf(tx, user.id);
    const toLabel = getStage(def.definition, toStage)?.label ?? toStage;
    const deskOpen = ap.deskItemId
      ? (await one(tx, 'SELECT status FROM desk_items WHERE id=$1', [ap.deskItemId]))?.status === 'open'
      : false;
    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'ApprovalDecided',
            payload: {
              cardId: card.id,
              stageId: stage.id,
              decision: kind,
              by: user.id,
              ...(text ? { note: text } : {}),
              toStage,
              ...(ap.deskItemId ? { deskItemId: ap.deskItemId } : {}),
              ...(kind === 'approved' && ap.sha ? { sha: ap.sha } : {}),
            },
          },
          actor: userActor(user.id),
          scope,
        },
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'StageCompleted',
            payload: {
              cardId: card.id,
              fromStage: stage.id,
              toStage,
              outcome: outcomeId,
              ...(kind === 'sent_back' ? { rework: true } : {}),
            },
          },
          actor: userActor(user.id),
          scope,
        },
        ...(deskOpen
          ? resolveDeskEvent(
              card,
              ap,
              user.id,
              kind === 'approved' ? 'approved' : 'rejected',
              text || (kind === 'approved' ? 'Approved' : 'Sent back'),
            )
          : []),
        ...(kind === 'sent_back' && text
          ? [
              cardMessage(
                card,
                { kind: 'user', userId: user.id },
                'comment',
                `Sent back from "${stage.label}": ${text}`,
                {
                  approval: 'sent_back',
                },
              ),
            ]
          : []),
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          kind === 'approved'
            ? `${who} approved ${card.ref} at "${stage.label}"${text ? `: ${text}` : '.'} It goes on to "${toLabel}".`
            : `${who} sent ${card.ref} back from "${stage.label}" to "${toLabel}". The comment is in the thread.`,
          { approval: kind },
        ),
      ],
      { tx },
    );
    return undefined;
  });
  ctx.services.dispatcher.trigger();
  return stale;
}

export async function approveStep(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  req: ApprovalApproveRequest,
): Promise<void> {
  const r = await decide(ctx, user, idOrRef, 'approved', req.note?.trim() || undefined);
  if (r === 'stale')
    throw conflict(
      'approval_stale',
      'the code changed after the diff was shown, so nothing was approved: read the new diff and approve again',
    );
}

export async function sendBackStep(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  req: ApprovalSendBackRequest,
): Promise<void> {
  const comment = req.comment.trim();
  if (!comment)
    throw badRequest('comment_required', 'say what is missing: the earlier step reads this comment');
  await decide(ctx, user, idOrRef, 'sent_back', comment);
}

// -------------------------------------------------------------------------------------------------- reads

/** The card detail's approval block (null when the card never reached an approval step, or the step is not the current one). */
export async function cardApprovalDto(
  db: Queryable,
  card: Row,
  viewer: { id: string },
  projectRole: 'owner' | 'manager' | null | undefined,
): Promise<CardApproval | null> {
  const ap = card.approval as ApprovalDoc | null;
  if (!ap) return null;
  const wf = await loadWorkflowById(db, card.workflow_version_id);
  const stage = wf ? getStage(wf.definition, ap.stageId) : undefined;
  if (!wf || !stage) return null;
  // Moved out by a manager before it was decided: nothing to show until it reaches the step again.
  if (ap.state === 'open' && card.stage !== ap.stageId) return null;
  const ids = [ap.approverUserId, ap.decision?.by].filter((x): x is string => !!x);
  const users = new Map(
    (await rows(db, 'SELECT id, display_name, avatar_seed FROM users WHERE id = ANY($1::uuid[])', [ids])).map(
      (u) => [u.id, u],
    ),
  );
  const label = (id: string | undefined) => (id ? (getStage(wf.definition, id)?.label ?? id) : null);
  const approveTo = stage.outcomes.find((o) => o.id === 'approve')?.to;
  const backTo = stage.outcomes.find((o) => o.id === 'send_back')?.to;
  const open =
    ap.state === 'open' &&
    card.stage === ap.stageId &&
    ['queued', 'claimed', 'waiting'].includes(card.status);
  const approver = users.get(ap.approverUserId);
  return {
    state: ap.state,
    stageId: ap.stageId,
    stageLabel: stage.label,
    approver: {
      userId: ap.approverUserId,
      name: approver?.display_name ?? 'someone',
      avatarSeed: approver?.avatar_seed ?? null,
    },
    approverKind: ap.approverKind,
    fellBack: ap.fellBack === true,
    openedAt: iso(ap.openedAt) as string,
    approveTo: label(approveTo),
    sendBackTo: label(backTo),
    decision: ap.decision
      ? {
          kind: ap.decision.kind,
          byName: users.get(ap.decision.by)?.display_name ?? 'someone',
          note: ap.decision.note,
          at: iso(ap.decision.at) as string,
        }
      : null,
    sentBackCount: ap.sentBackCount ?? 0,
    canAct: open && (await mayDecide(db, viewer, card, projectRole)),
    deskItemId: ap.deskItemId,
    ...(card.head_sha ? { review: await approvalReviewInfo(db, card, ap) } : {}),
  };
}

/** code-v6: what the owner is shown at the approval step: the commit, why it is needed, the diff, the evidence and the verdicts. */
async function approvalReviewInfo(db: Queryable, card: Row, ap: ApprovalDoc): Promise<ApprovalReviewInfo> {
  const diff = await one(db, 'SELECT sha, bytes, truncated, files FROM card_diffs WHERE card_id=$1', [
    card.id,
  ]);
  const ev = card.build_evidence as {
    commands?: Array<{ kind: string; command: string; status: string; result: string }>;
    waived?: string;
  } | null;
  const verdicts = await rows(
    db,
    `SELECT a.name, h.note, h.data FROM card_handoffs h LEFT JOIN agents a ON a.id = h.agent_id
      WHERE h.card_id=$1 AND h.stage IN ('review','merge_review') AND h.outcome='approve'
      ORDER BY h.created_at, h.event_seq`,
    [card.id],
  );
  return {
    sha: ap.sha ?? (card.head_sha as string | null),
    stale: !!ap.sha && !!card.head_sha && ap.sha !== card.head_sha,
    highRisk: card.high_risk === true,
    highRiskPaths: ((card.high_risk_paths ?? []) as string[]).slice(0, 50),
    riskTier: (card.risk_tier as string | null) ?? null,
    reason: card.owner_approval_reason
      ? (OWNER_APPROVAL_REASON_TEXT[card.owner_approval_reason as OwnerApprovalReason] ?? null)
      : null,
    diff: diff ? { bytes: Number(diff.bytes), truncated: !!diff.truncated, files: Number(diff.files) } : null,
    evidence: ev ? { commands: ev.commands ?? [], waived: ev.waived ?? null } : null,
    verdicts: verdicts.map((v) => ({
      reviewerName: v.name ?? 'a reviewer',
      score: Number(v.data?.score ?? 0),
      risk: (v.data?.risk as string | undefined) ?? null,
      comments: String(v.note ?? '').slice(0, 4000),
    })),
    designSummary: (card.investigation as { summary?: string } | null)?.summary ?? null,
    cardBrief: (card.card_brief as string | null) ?? null,
  };
}

/** `GET /api/cards/:id/diff`: the diff stored at the review handoff, for any member who can see the card. */
export async function cardDiff(
  db: Queryable,
  user: { id: string },
  idOrRef: string,
): Promise<CardDiffResponse> {
  const visible = await loadVisibleCard(db, user.id, idOrRef);
  const d = await one(db, 'SELECT * FROM card_diffs WHERE card_id=$1', [visible.card.id]);
  if (!d) throw notFound('no_diff', 'no diff was stored for this card');
  return {
    sha: d.sha,
    base: d.base,
    body: d.body,
    bytes: Number(d.bytes),
    truncated: !!d.truncated,
    files: Number(d.files),
    at: iso(d.created_at) as string,
  };
}
