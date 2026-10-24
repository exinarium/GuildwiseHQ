import {
  CEO_DECISION_SUBKIND,
  canAnswerCardDeskItem,
  type DeskItemDto,
  type DeskListResponse,
  type DigestItemDto,
  isOrgManager,
  isPhaseDeskSubkind,
  isProjectMember,
  isProjectOwner,
  type OrgRole,
  type ProjectRole,
} from '@aom/shared';
import { iso, type Queryable, type Row, rows } from '../db/sql.ts';
import { userAvatarOf } from '../dto.ts';
import { digestItemsForDesk } from './digests.ts';
import { phaseDeskBlock } from './phases.ts';

const SELECT = `
SELECT d.*, c.ref AS card_ref, c.title AS card_title, c.stage AS card_stage, c.status AS card_status,
       c.owner_user_id AS card_owner, c.decision_policy AS card_policy, p.key AS project_key, p.merge_large_without_approval AS project_merge_large_ok,
       a.name AS agent_name, u.display_name AS answered_by_name, aa.name AS answered_by_agent_name, aa.role_key AS answered_by_agent_role,
       u.avatar_kind, u.avatar_seed, u.avatar_style, u.avatar_image_id,
       (SELECT i.id FROM intakes i WHERE i.mapping_desk_item_id = d.id) AS intake_id,
       (SELECT json_build_object('agentName', ca.name, 'reason', x.reason, 'confidence', x.confidence, 'undoable', (x.status = 'done' AND x.inverse IS NOT NULL))
          FROM ceo_actions x LEFT JOIN agents ca ON ca.id = (SELECT agent_id FROM ceo_settings cs WHERE cs.org_id = x.org_id)
         WHERE x.id = d.ceo_action_id) AS ceo_action,
       (SELECT ca2.name FROM ceo_settings cs2 JOIN agents ca2 ON ca2.id = cs2.agent_id WHERE cs2.org_id = d.org_id) AS ceo_name,
       (SELECT json_build_object('id', ii.id, 'name', ii.name) FROM interests ii WHERE ii.project_id = d.project_id AND d.kind = 'rating') AS interest,
       (SELECT json_build_object('nudgedAt', f.last_nudge_at, 'nudgeCount', f.nudge_count, 'snoozedUntil', f.snoozed_until)
          FROM desk_follow_ups f WHERE f.desk_item_id = d.id AND (f.nudge_count > 0 OR f.snoozed_until IS NOT NULL)) AS follow_up
  FROM desk_items d
  LEFT JOIN cards c ON c.id = d.card_id
  LEFT JOIN projects p ON p.id = d.project_id
  LEFT JOIN agents a ON a.id = d.asked_by_agent_id
  LEFT JOIN users u ON u.id = d.answered_by
  LEFT JOIN agents aa ON aa.id = d.answered_by_agent_id`;

/**
 * SQL for "a CEO decision the owner reviews": the legacy informational item, or a desk item the CEO resolved (its
 * decision is recorded on the item itself). Table alias `d`.
 */
export const IS_CEO_DECISION_SQL = `(COALESCE(d.subkind, '') = '${CEO_DECISION_SUBKIND}' OR d.data->'ceoDecision' IS NOT NULL)`;
/** ...and the owner has not acknowledged or corrected it yet. Open legacy items count as unreviewed (alias `d`). */
export const UNREVIEWED_CEO_DECISION_SQL = `(${IS_CEO_DECISION_SQL} AND (d.data->>'acknowledgedAt') IS NULL AND (d.data->'correction') IS NULL AND (COALESCE(d.subkind, '') <> '${CEO_DECISION_SUBKIND}' OR d.status = 'open'))`;

/**
 * Desk items the user may see (docs/design/organizations.md section 6): the items of projects they are an active
 * member of, and the org-level items of organizations where they are Owner or Admin, plus the ones addressed to them.
 */
export const DESK_VISIBLE = `((d.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active')
   OR (d.project_id IS NULL AND (d.addressee_user_id = $1
        OR EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = d.org_id AND om.user_id = $1
                     AND om.status = 'active' AND om.role IN ('owner','admin'))))) AND d.triage <> 'pending')`;

/**
 * May `userId` answer this item? (docs/ARCHITECTURE.md section 17.2) `orgRole` is the user's role in the item's
 * organization: org-level items are answered by its Owner and Admins, or only by their addressee when they have one.
 */
export function canAnswerItem(
  r: Row,
  userId: string,
  role: ProjectRole,
  orgRole: OrgRole | null = null,
): boolean {
  // Ratings: any active member of the project (the digest belongs to the whole project).
  if (r.kind === 'rating') return role !== null;
  // Phases: any active member of the project may act (owner decision A1).
  if (isPhaseDeskSubkind(r.subkind)) return role !== null;
  // Manual QA: the person it is addressed to, the project's owner and managers, organization Owners and Admins.
  if (r.subkind === 'manual_qa')
    return r.addressee_user_id === userId || isProjectMember(role) || isOrgManager({ orgRole });
  // An approval step: the person asked, the project owner, organization Owners and Admins.
  if (r.subkind === 'approval_step')
    return r.addressee_user_id === userId || isProjectOwner(role) || isOrgManager({ orgRole });
  if (r.card_id) {
    return canAnswerCardDeskItem({
      userId,
      projectRole: role,
      cardOwnerUserId: r.card_owner,
      policy: r.card_policy ?? 'owner_only',
    });
  }
  if (r.project_id) return isProjectOwner(role);
  // G-Q8: a DevOps approval is answered by the workstation's user AND an Owner/Admin (two parties when different).
  if (r.kind === 'approval' && r.subkind === 'devops')
    return r.addressee_user_id === userId || isOrgManager({ orgRole });
  if (r.addressee_user_id) return r.addressee_user_id === userId;
  return isOrgManager({ orgRole });
}

export async function dedupEntriesFor(db: Queryable, ids: string[]) {
  if (ids.length === 0) return new Map<string, { id: string; scope: any; title: string; body: string }>();
  const found = await rows(
    db,
    'SELECT id, scope, title, body FROM ledger_entries WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return new Map(found.map((r) => [r.id, { id: r.id, scope: r.scope, title: r.title, body: r.body }]));
}

export function toDeskDto(
  r: Row,
  userId: string,
  roles: Map<string, ProjectRole>,
  dedup: Map<string, { id: string; scope: any; title: string; body: string }>,
  orgRoles: Map<string, OrgRole> = new Map(),
): DeskItemDto {
  const role = r.project_id ? (roles.get(r.project_id) ?? null) : null;
  return {
    id: r.id,
    kind: r.kind,
    subkind: r.subkind,
    status: r.status,
    routedTo: r.routed_to,
    title: r.title,
    body: r.body,
    doing: r.doing,
    options: r.options,
    recommendation: r.recommendation,
    blocking: r.blocking,
    pinned: r.pinned,
    urgent: r.pinned,
    affectedCardIds: r.affected_card_ids,
    affectedCount: r.affected_card_ids.length,
    askedBy: {
      kind: r.asked_by_kind,
      agentId: r.asked_by_agent_id,
      agentName: r.agent_name,
      role: r.asked_by_role,
    },
    card: r.card_id
      ? {
          id: r.card_id,
          ref: r.card_ref,
          title: r.card_title,
          stage: r.card_stage,
          status: r.card_status,
          projectKey: r.project_key,
        }
      : null,
    projectId: r.project_id,
    ...(r.data &&
    typeof r.data === 'object' &&
    (r.data.workstationId || r.data.key || r.data.askId || r.subkind === 'playbook_input_needed')
      ? {
          data: {
            ...(typeof r.data.workstationId === 'string' ? { workstationId: r.data.workstationId } : {}),
            ...(typeof r.data.key === 'string' ? { key: r.data.key } : {}),
            ...(r.subkind === 'playbook_input_needed' && typeof r.data.threadId === 'string'
              ? { threadId: r.data.threadId }
              : {}),
            // "Authorize this execution" (docs/design/ceo-front-door.md section 14.1)
            ...(r.subkind === 'ceo_permission'
              ? Object.fromEntries(
                  (['askId', 'turnId', 'tool', 'input', 'reason', 'expiresAt'] as const)
                    .filter((k) => typeof r.data[k] === 'string')
                    .map((k) => [k, r.data[k]]),
                )
              : {}),
          },
        }
      : {}),
    ...(r.interest ? { interest: r.interest } : {}),
    ...(r.follow_up ? { followUp: r.follow_up } : {}),
    dedupEntries: (r.dedup_ledger_ids as string[]).flatMap((id) => {
      const e = dedup.get(id);
      return e ? [e] : [];
    }),
    answer: r.answer,
    answerOption: r.answer_option,
    answeredAt: iso(r.answered_at),
    answeredByName: r.answered_by_name,
    answeredByUserId: r.answered_by ?? null,
    answeredByAvatar: r.answered_by ? userAvatarOf(r) : null,
    answeredByAgentId: r.answered_by_agent_id ?? null,
    answeredByAgentName: r.answered_by_agent_name ?? null,
    answeredByAgentRole: r.answered_by_agent_role ?? null,
    escalationTrail: r.escalation_trail ?? [],
    hint:
      r.status === 'open' && r.subkind === 'large_merge' && r.project_merge_large_ok
        ? "The project setting 'Merge large changes without my approval' is now on, so this merge would no longer need your approval. You can still approve it here."
        : null,
    intakeId: r.intake_id ?? null,
    decisionPolicy: r.card_policy ?? null,
    baNote: r.ba_note ?? null,
    baNoteAt: iso(r.ba_note_at),
    triage: r.triage,
    supersededBy: r.superseded_by ?? null,
    ...((r.repeat_count ?? 1) > 1 ? { repeatCount: r.repeat_count as number } : {}),
    chatThreadId: r.chat_thread_id ?? null,
    floor: r.subkind === 'floor_report' ? (r.data ?? null) : null,
    budgetProject:
      typeof r.subkind === 'string' && r.subkind.startsWith('budget_') && r.data?.projectId
        ? {
            projectId: r.data.projectId,
            projectKey: r.data.projectKey ?? '',
            ...(r.data.interestId ? { interestId: r.data.interestId } : {}),
          }
        : null,
    ...(r.ceo_action || r.ceo_recommendation
      ? {
          ceo: {
            actionId: r.ceo_action_id ?? null,
            agentName: r.ceo_action?.agentName ?? r.ceo_name ?? null,
            reason: r.ceo_action?.reason ?? r.ceo_recommendation?.reason ?? null,
            confidence: r.ceo_action?.confidence ?? r.ceo_recommendation?.confidence ?? null,
            undoable: r.ceo_action?.undoable === true,
            recommendation: r.ceo_recommendation
              ? {
                  actionId: r.ceo_recommendation.actionId,
                  option: r.ceo_recommendation.option ?? null,
                  text: r.ceo_recommendation.text ?? null,
                  reason: r.ceo_recommendation.reason,
                  confidence: r.ceo_recommendation.confidence,
                }
              : null,
          },
        }
      : {}),
    ...(r.data?.ceoDecision
      ? {
          ceoDecision: {
            question: r.data.ceoDecision.question ?? '',
            decision: r.data.ceoDecision.decision ?? '',
            reason: r.data.ceoDecision.reason ?? '',
            confidence: r.data.ceoDecision.confidence ?? null,
            ceoName: r.data.ceoDecision.ceoName ?? null,
            class: r.data.ceoDecision.class ?? null,
            source: r.data.ceoDecision.source === 'chain' ? ('chain' as const) : ('act' as const),
            questionItemId: r.data.ceoDecision.questionItemId ?? null,
            reviewed: !!(r.data.acknowledgedAt || r.data.correction),
            correction: r.data.correction
              ? {
                  text: r.data.correction.text ?? '',
                  at: r.data.correction.at ?? iso(r.updated_at),
                  applied: r.data.correction.applied ?? null,
                  review: (r.data.correction.review ?? 'pending') as
                    | 'pending'
                    | 'analysed'
                    | 'lesson'
                    | 'done',
                  analysis: r.data.correction.analysis ?? null,
                  lesson: r.data.correction.lesson ?? null,
                  consequences: r.data.correction.consequences ?? null,
                  ...(r.data.correction.proposedCards
                    ? { proposedCards: r.data.correction.proposedCards }
                    : {}),
                  noFixReason: r.data.correction.noFixReason ?? null,
                  ceoReply: r.data.correction.ceoReply ?? null,
                  final: r.data.correction.final ?? null,
                }
              : null,
            acknowledgedAt: r.data.acknowledgedAt ?? null,
          },
        }
      : {}),
    ...(r.subkind === 'ceo_report' && r.data?.ceo
      ? {
          ceoReport: {
            actions: r.data.ceo.actions ?? [],
            ...(r.data.ceo.repeats ? { repeats: r.data.ceo.repeats } : {}),
            ...(r.data.ceo.orderTurns ? { orderTurns: r.data.ceo.orderTurns } : {}),
            scores: r.data.ceo.scores ?? [],
            fallback: r.data.fallback === true,
          },
        }
      : {}),
    canAnswer: r.status === 'open' && canAnswerItem(r, userId, role, orgRoles.get(r.org_id) ?? null),
    createdAt: iso(r.created_at) as string,
  };
}

const withDigest = (dto: DeskItemDto, digests: Map<string, DigestItemDto[]>): DeskItemDto =>
  dto.kind === 'rating' ? { ...dto, digestItems: digests.get(dto.id) ?? [] } : dto;

/** Phase items carry the live data of their phase (members, follow-ups, reports). */
async function withPhase(db: Queryable, dto: DeskItemDto, r: Row): Promise<DeskItemDto> {
  return isPhaseDeskSubkind(r.subkind) ? { ...dto, phase: await phaseDeskBlock(db, r) } : dto;
}

async function orgRolesOf(db: Queryable, userId: string): Promise<Map<string, OrgRole>> {
  const list = await rows<{ org_id: string; role: OrgRole }>(
    db,
    `SELECT org_id, role FROM org_members WHERE user_id=$1 AND status='active'`,
    [userId],
  );
  return new Map(list.map((r) => [r.org_id, r.role]));
}

async function rolesOf(db: Queryable, userId: string): Promise<Map<string, ProjectRole>> {
  const list = await rows<{ project_id: string; role: 'owner' | 'manager' }>(
    db,
    `SELECT project_id, role FROM project_members WHERE user_id=$1 AND status='active'`,
    [userId],
  );
  return new Map(list.map((r) => [r.project_id, r.role]));
}

/**
 * `GET /api/desk`. Open items are ordered pinned DESC, blocking DESC, affected-card count DESC, age ASC; closed
 * items (answered, dismissed, superseded) follow, newest first.
 */
export async function listDesk(
  db: Queryable,
  userId: string,
  orgId: string | null,
  opts: { projectId?: string | undefined; status: 'open' | 'closed' | 'all' },
): Promise<DeskListResponse> {
  const params = [userId, opts.projectId ?? null, orgId];
  // The tab's organization, plus the projects of organizations where the user is only a guest.
  const scope = `${DESK_VISIBLE} AND ($2::uuid IS NULL OR d.project_id = $2)
    AND (d.org_id = $3::uuid OR NOT EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = d.org_id AND om.user_id = $1 AND om.status = 'active'))`;
  const open =
    opts.status === 'closed'
      ? []
      : await rows(
          db,
          // Next to the open items: what the CEO decided on a question or stop-loss (resolved, the decision on the item) until the owner reviews it.
          `${SELECT} WHERE ${scope} AND ((d.status = 'open' AND d.routed_to = 'manager')
              OR (d.status <> 'open' AND d.subkind IS DISTINCT FROM '${CEO_DECISION_SUBKIND}' AND ${UNREVIEWED_CEO_DECISION_SQL}))
            ORDER BY d.pinned DESC, d.blocking DESC, cardinality(d.affected_card_ids) DESC, d.created_at ASC, d.id`,
          params,
        );
  const closed =
    opts.status === 'open'
      ? []
      : await rows(
          db,
          `${SELECT} WHERE ${scope} AND d.status <> 'open' AND NOT (d.subkind IS DISTINCT FROM '${CEO_DECISION_SUBKIND}' AND ${UNREVIEWED_CEO_DECISION_SQL}) ORDER BY d.updated_at DESC, d.id LIMIT 100`,
          params,
        );
  const all = [...open, ...closed];
  const dedup = await dedupEntriesFor(db, [...new Set(all.flatMap((r) => r.dedup_ledger_ids as string[]))]);
  const roles = await rolesOf(db, userId);
  const orgRoles = await orgRolesOf(db, userId);
  const digests = await digestItemsForDesk(
    db,
    all.filter((r) => r.kind === 'rating').map((r) => r.id),
  );
  const items: DeskItemDto[] = [];
  for (const r of all)
    items.push(await withPhase(db, withDigest(toDeskDto(r, userId, roles, dedup, orgRoles), digests), r));
  const openItems = items.filter((i) => i.status === 'open');
  // CEO decisions are for review, not decisions waiting on the user: they are not part of the open count.
  const decisions = items.filter((i) => i.ceoDecision && !i.ceoDecision.reviewed).length;
  const legacyDecisions = openItems.filter((i) => i.subkind === CEO_DECISION_SUBKIND).length;
  return {
    items,
    counts: {
      open: openItems.length - legacyDecisions,
      ...(decisions > 0 ? { ceoDecisions: decisions } : {}),
      blocking: openItems.filter((i) => i.blocking).length,
      urgent: openItems.filter((i) => i.urgent).length,
    },
  };
}

export async function getDeskDto(
  db: Queryable,
  userId: string,
  id: string,
): Promise<DeskItemDto | undefined> {
  const r = (await rows(db, `${SELECT} WHERE d.id = $2 AND ${DESK_VISIBLE}`, [userId, id]))[0];
  if (!r) return undefined;
  const dedup = await dedupEntriesFor(db, r.dedup_ledger_ids);
  const digests = await digestItemsForDesk(db, r.kind === 'rating' ? [r.id] : []);
  return withPhase(
    db,
    withDigest(toDeskDto(r, userId, await rolesOf(db, userId), dedup, await orgRolesOf(db, userId)), digests),
    r,
  );
}

/** Raw row (with card columns) for command-side authorization. */
export async function loadDeskRow(db: Queryable, userId: string, id: string): Promise<Row | undefined> {
  return (await rows(db, `${SELECT} WHERE d.id = $2 AND ${DESK_VISIBLE}`, [userId, id]))[0];
}
