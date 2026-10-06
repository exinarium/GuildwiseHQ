import {
  canAnswerCardDeskItem,
  type DeskItemDto,
  type DeskListResponse,
  type DigestItemDto,
  isOrgManager,
  isPhaseDeskSubkind,
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
       a.name AS agent_name, u.display_name AS answered_by_name, aa.name AS answered_by_agent_name,
       u.avatar_kind, u.avatar_seed, u.avatar_style, u.avatar_image_id,
       (SELECT i.id FROM intakes i WHERE i.mapping_desk_item_id = d.id) AS intake_id
  FROM desk_items d
  LEFT JOIN cards c ON c.id = d.card_id
  LEFT JOIN projects p ON p.id = d.project_id
  LEFT JOIN agents a ON a.id = d.asked_by_agent_id
  LEFT JOIN users u ON u.id = d.answered_by
  LEFT JOIN agents aa ON aa.id = d.answered_by_agent_id`;

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
  if (r.card_id) {
    return canAnswerCardDeskItem({
      userId,
      projectRole: role,
      cardOwnerUserId: r.card_owner,
      policy: r.card_policy ?? 'owner_only',
    });
  }
  if (r.project_id) return isProjectOwner(role);
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
    chatThreadId: r.chat_thread_id ?? null,
    floor: r.subkind === 'floor_report' ? (r.data ?? null) : null,
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
          `${SELECT} WHERE ${scope} AND d.status = 'open' AND d.routed_to = 'manager'
            ORDER BY d.pinned DESC, d.blocking DESC, cardinality(d.affected_card_ids) DESC, d.created_at ASC, d.id`,
          params,
        );
  const closed =
    opts.status === 'open'
      ? []
      : await rows(
          db,
          `${SELECT} WHERE ${scope} AND d.status <> 'open' ORDER BY d.updated_at DESC, d.id LIMIT 100`,
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
  return {
    items,
    counts: {
      open: openItems.length,
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
