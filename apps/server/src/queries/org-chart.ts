import type { OrgChart, OrgChartAgent, OrgChartStatus } from '@aom/shared';
import { ceoActive } from '../ceo/state.ts';
import { orgCostCtx, spendBriefs } from '../costs/index.ts';
import type { Queryable } from '../db/sql.ts';
import { iso, type Row, rows } from '../db/sql.ts';
import { ONLINE_WINDOW_MS } from '../dispatcher/candidates.ts';

const RECENT_SHIFTS = 5;

/** `delivery` -> `Delivery`, `knowledge_ops` -> `Knowledge ops`. A custom department already is its display name. */
export const departmentLabel = (key: string): string =>
  /^[a-z][a-z0-9_-]*$/.test(key) ? `${key[0]?.toUpperCase()}${key.slice(1).replace(/[_-]/g, ' ')}` : key;

/** The built-in departments come first, in the order the work flows; custom ones follow alphabetically. */
const DEPARTMENT_ORDER = ['management', 'delivery', 'research', 'knowledge', 'operations'];
const deptRank = (k: string) => {
  const i = DEPARTMENT_ORDER.indexOf(k);
  return i === -1 ? DEPARTMENT_ORDER.length : i;
};

/**
 * The organization chart (nav: Organization, Org chart): every active agent of the organization with its role,
 * seniority, status, workstation, reporting line (hiring manager, then the Owner) and escalation (a senior of its role,
 * then the BA, then the manager's desk). Visible to organization members; guests get none.
 */
export async function getOrgChart(db: Queryable, orgId: string, now: Date): Promise<OrgChart> {
  const org = await rows(
    db,
    `SELECT o.owner_user_id, u.display_name FROM organizations o JOIN users u ON u.id = o.owner_user_id WHERE o.id=$1`,
    [orgId],
  );
  const admins = await rows(
    db,
    `SELECT u.id, u.display_name FROM org_members om JOIN users u ON u.id = om.user_id
      WHERE om.org_id=$1 AND om.status='active' AND om.role='admin' ORDER BY lower(u.display_name)`,
    [orgId],
  );
  const online = new Date(now.getTime() - ONLINE_WINDOW_MS);
  const list = await rows(
    db,
    `SELECT a.*, ws.name AS ws_name, (ws.connected AND ws.last_seen_at > $2) AS ws_online,
            mu.display_name AS manager_name, mom.role AS manager_org_role,
            (SELECT r.definition->>'name' FROM role_definitions r
              WHERE r.key = a.role_key AND (r.org_id = a.org_id OR r.org_id IS NULL) AND r.status = 'active'
              ORDER BY (r.org_id IS NULL), r.version DESC LIMIT 1) AS role_name,
            (SELECT r.definition->>'department' FROM role_definitions r
              WHERE r.key = a.role_key AND (r.org_id = a.org_id OR r.org_id IS NULL)
              ORDER BY (r.version = a.role_version) DESC, (r.org_id IS NULL), r.version DESC LIMIT 1) AS department
       FROM agents a
       LEFT JOIN workstations ws ON ws.id = a.workstation_id
       LEFT JOIN users mu ON mu.id = a.manager_user_id
       LEFT JOIN org_members mom ON mom.org_id = a.org_id AND mom.user_id = a.manager_user_id AND mom.status = 'active'
      WHERE a.org_id = $1 AND a.status <> 'retired'
      ORDER BY a.hired_at, a.id`,
    [orgId, online],
  );
  const ids = list.map((a) => a.id as string);
  const claims = await rows(
    db,
    `SELECT id, ref, title, claimed_by_agent_id FROM cards
      WHERE claimed_by_agent_id = ANY($1::uuid[]) AND claim_id IS NOT NULL`,
    [ids],
  );
  const blocked = await rows(
    db,
    `SELECT id, ref, title, last_agent_id FROM cards WHERE status='blocked' AND last_agent_id = ANY($1::uuid[]) ORDER BY number`,
    [ids],
  );
  const recent = await rows(
    db,
    `SELECT x.* FROM unnest($1::uuid[]) AS agent(id)
       CROSS JOIN LATERAL (
         SELECT s.id AS shift_id, s.agent_id, s.kind, s.outcome, s.ended_at, c.id AS card_id, c.ref, c.title
           FROM shifts s LEFT JOIN cards c ON c.id = s.card_id
          WHERE s.agent_id = agent.id AND s.status = 'ended'
          ORDER BY s.ended_at DESC NULLS LAST, s.id LIMIT ${RECENT_SHIFTS}) x`,
    [ids],
  );
  const cost = await orgCostCtx(db, orgId);
  const spend = await spendBriefs(db, cost, now, 'agent', ids);

  const ceoAgent = list.find((a) => a.role_key === 'ceo' && a.status === 'active');
  // The same CEO the routing asks (commands/escalation.ts nextRoute): enabled, not paused, with an active agent.
  const ceoOn = await ceoActive(db, orgId);
  const ceoUp = ceoOn ? list.find((a) => a.id === ceoOn.agentId) : undefined;
  const bas = list.filter((a) => a.role_key === 'ba' && !a.is_devops && a.status === 'active');
  const seniorsOf = (a: Row) =>
    list.filter(
      (x) =>
        x.role_key === a.role_key &&
        x.seniority === 'senior' &&
        x.id !== a.id &&
        x.status === 'active' &&
        !x.is_devops,
    );

  const agents: OrgChartAgent[] = list.map((a) => {
    const mine = claims.filter((c) => c.claimed_by_agent_id === a.id);
    const stuck = blocked.filter((c) => c.last_agent_id === a.id);
    let status: OrgChartStatus = 'idle';
    if (a.status === 'needs_rehome') status = 'needs_rehome';
    else if (!a.ws_online) status = 'offline';
    else if (mine.length) status = 'working';
    else if (stuck.length) status = 'blocked';
    const seniors = a.is_devops || a.role_key === 'ba' || a.role_key === 'ceo' ? [] : seniorsOf(a);
    // peer -> CEO when active (the BA is skipped then, as in the routing) -> else BA -> desk; a step nobody can take is skipped.
    const up = ceoUp
      ? { level: 'ceo' as const, agentIds: [ceoUp.id as string] }
      : { level: 'desk' as const, agentIds: [] };
    const escalatesTo =
      a.is_devops || a.role_key === 'ceo'
        ? { level: 'desk' as const, agentIds: [] }
        : a.role_key === 'ba'
          ? up
          : a.seniority === 'junior' && seniors.length
            ? { level: 'peer' as const, agentIds: seniors.map((s) => s.id as string) }
            : !ceoUp && bas.length
              ? { level: 'ba' as const, agentIds: bas.map((b) => b.id as string) }
              : up;
    return {
      id: a.id,
      name: a.name,
      roleKey: a.role_key,
      roleLabel: a.role_name ?? a.role_key,
      department: a.department ?? null,
      seniority: a.seniority,
      isDevops: Boolean(a.is_devops),
      status,
      avatarSeed: a.avatar_seed ?? a.id,
      avatarStyle: a.avatar_style ?? 'notionists',
      runtime: a.runtime,
      model: a.model,
      capacity: a.capacity,
      hiredAt: iso(a.hired_at) as string,
      workstation: a.workstation_id
        ? { id: a.workstation_id, name: a.ws_name ?? 'Workstation', online: Boolean(a.ws_online) }
        : null,
      reportsTo: {
        userId: a.manager_user_id,
        name: a.manager_name ?? 'Unknown',
        orgRole: a.manager_org_role ?? null,
      },
      escalatesTo,
      allowedProjectIds: a.allowed_project_ids ?? null,
      focusProjectIds: a.focus_project_ids ?? [],
      activeCards: mine.map((c) => ({ cardId: c.id, ref: c.ref, title: c.title })),
      blockedCards: stuck.map((c) => ({ cardId: c.id, ref: c.ref, title: c.title })),
      recentWork: recent
        .filter((r) => r.agent_id === a.id)
        .map((r) => ({
          shiftId: r.shift_id,
          kind: r.kind,
          outcome: r.outcome ?? null,
          endedAt: iso(r.ended_at),
          cardId: r.card_id ?? null,
          ref: r.ref ?? null,
          title: r.title ?? null,
        })),
      spend: spend.get(a.id as string) ?? { monthMicros: 0, totalMicros: 0, currency: cost.currency },
    };
  });

  const departments = [...new Set(agents.filter((a) => !a.isDevops).map((a) => a.department ?? 'other'))]
    .sort((a, b) => deptRank(a) - deptRank(b) || a.localeCompare(b))
    .map((key) => ({ key, label: departmentLabel(key) }));

  const projects = await rows(
    db,
    `SELECT id, key, name FROM projects WHERE org_id=$1 AND kind='project' AND status='active' ORDER BY created_at`,
    [orgId],
  );
  const stations = await rows(
    db,
    `SELECT w.id, w.name, (w.connected AND w.last_seen_at > $2) AS online, u.display_name AS owner_name
       FROM workstations w JOIN users u ON u.id = w.user_id
      WHERE w.status = 'active' AND w.id = ANY($1::uuid[]) ORDER BY w.name, w.id`,
    [[...new Set(list.map((a) => a.workstation_id).filter(Boolean))], online],
  );
  return {
    owner: { userId: org[0]?.owner_user_id, name: org[0]?.display_name ?? 'Owner' },
    admins: admins.map((u) => ({ userId: u.id, name: u.display_name })),
    departments,
    agents,
    ceo: ceoAgent ? { agentId: ceoAgent.id as string, paused: Boolean(ceoAgent.paused_at) } : null,
    projects: projects.map((p) => ({ id: p.id, key: p.key, name: p.name })),
    workstations: stations.map((w) => ({
      id: w.id,
      name: w.name,
      online: Boolean(w.online),
      ownerName: w.owner_name,
      devopsAgentId: list.find((a) => a.workstation_id === w.id && a.is_devops)?.id ?? null,
      agentIds: list.filter((a) => a.workstation_id === w.id && !a.is_devops).map((a) => a.id as string),
    })),
  };
}
