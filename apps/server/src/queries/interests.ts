import {
  type DeliverySpec,
  type EligibleAgentsResponse,
  type FeedVerdict,
  type InterestAgents,
  type InterestDetailResponse,
  type InterestDto,
  type InterestRunDetailResponse,
  type InterestRunDto,
  type InterestRunsQuerySchema,
  type InterestStats,
  type InterestsQuerySchema,
  OPEN_RUN_STATUSES,
  renderTasteEntry,
  renderTasteRule,
  type ScanSpec,
} from '@aom/shared';
import type { z } from 'zod';
import { budgetDto, monthSpendByProject, orgCostCtx, spendBriefs } from '../costs/index.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';

type Query = z.infer<typeof InterestsQuerySchema>;
type RunsQuery = z.infer<typeof InterestRunsQuerySchema>;

const ONLINE_MS = 45_000;

const EMPTY_STATS: InterestStats = {
  lastRunAt: null,
  lastRun: null,
  nextScanAt: null,
  nextDeliveryAt: null,
  lastDeliveredAt: null,
  runs30d: 0,
  items: { total: 0, last30d: 0, lastRun: 0, held: 0 },
  ratings: { useful: 0, irrelevant: 0, boring: 0, unrated: 0 },
  research: { open: 0, published: 0 },
  failing: false,
  failCount: 0,
  lastError: null,
};

/**
 * The edit rule of an interest (docs/design/organizations.md section 4.3) in SQL: its creator, or someone whose rank in the
 * interest's organization is at least the creator's current rank (the stored rank once the creator has no relationship
 * with it any more). Owner 4, Admin 3, Member 2, Guest (project access only) 1.
 */
const RANK_OF = (user: string) => `(CASE
    (SELECT om.role FROM org_members om WHERE om.org_id = i.org_id AND om.user_id = ${user} AND om.status = 'active')
    WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'member' THEN 2
    ELSE (CASE WHEN EXISTS (SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id
                             WHERE pm.user_id = ${user} AND pm.status = 'active' AND p.org_id = i.org_id) THEN 1 END)
  END)`;
const EDIT_OK = `(i.created_by = $1 OR COALESCE(${RANK_OF('$1')}, 1) >= COALESCE(
    CASE WHEN i.created_by IS NULL THEN NULL ELSE ${RANK_OF('i.created_by')} END, i.created_by_rank, 1))`;

const SELECT = `
  SELECT i.*, bp.key AS project_key, bp.status AS project_status, bp.vault_dir AS project_vault_dir,
         bp.budget_micros, bp.budget_override_month,
         cu.display_name AS creator_name,
         ${EDIT_OK} AS edit_ok,
         EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = i.org_id AND om.user_id = $1
                  AND om.status = 'active' AND om.role IN ('owner','admin')) AS can_share
    FROM interests i
    JOIN projects bp ON bp.id = i.project_id AND bp.kind = 'interest'
    JOIN project_members me ON me.project_id = i.project_id AND me.user_id = $1 AND me.status = 'active'
    LEFT JOIN users cu ON cu.id = i.created_by`;

/** Stats for the given interests in one query round (CTEs grouped by `cards.interest_id`). */
async function statsFor(db: Queryable, ids: string[], now: Date): Promise<Map<string, InterestStats>> {
  const out = new Map<string, InterestStats>();
  if (ids.length === 0) return out;
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const r = await rows(
    db,
    `WITH last_run AS (
       SELECT DISTINCT ON (r.interest_id) r.interest_id, r.id, r.kind, r.status, r.found, r.published, r.started_at, c.ref
         FROM interest_runs r JOIN cards c ON c.id = r.card_id WHERE r.interest_id = ANY($1::uuid[])
        ORDER BY r.interest_id, r.started_at DESC, r.id DESC
     ), last_scan AS (
       SELECT DISTINCT ON (interest_id) interest_id, card_id FROM interest_runs
        WHERE interest_id = ANY($1::uuid[]) AND kind = 'scan' ORDER BY interest_id, started_at DESC, id DESC
     ), runs AS (
       SELECT interest_id, count(*) FILTER (WHERE started_at >= $2) AS runs30d,
              count(*) FILTER (WHERE kind = 'research' AND status = ANY($3::text[])) AS res_open
         FROM interest_runs WHERE interest_id = ANY($1::uuid[]) GROUP BY interest_id
     ), items AS (
       SELECT c.interest_id,
              count(*) AS total,
              count(*) FILTER (WHERE d.created_at >= $2) AS last30d,
              count(*) FILTER (WHERE d.card_id = l.card_id) AS last_run,
              count(*) FILTER (WHERE d.delivered_at IS NULL) AS held,
              count(*) FILTER (WHERE d.verdict = 'useful') AS useful,
              count(*) FILTER (WHERE d.verdict = 'irrelevant') AS irrelevant,
              count(*) FILTER (WHERE d.verdict = 'boring') AS boring,
              count(*) FILTER (WHERE d.verdict IS NULL AND d.delivered_at IS NOT NULL) AS unrated
         FROM digest_items d JOIN cards c ON c.id = d.card_id
         LEFT JOIN last_scan l ON l.interest_id = c.interest_id
        WHERE c.interest_id = ANY($1::uuid[]) GROUP BY c.interest_id
     ), pubs AS (
       SELECT c.interest_id, count(*) AS published FROM research_publications rp JOIN cards c ON c.id = rp.card_id
        WHERE c.interest_id = ANY($1::uuid[]) GROUP BY c.interest_id
     )
     SELECT i.id, l.id AS last_id, l.kind AS last_kind, l.status AS last_status, l.found AS last_found,
            l.published AS last_published, l.started_at AS last_at, l.ref AS last_ref,
            coalesce(rn.runs30d, 0) AS runs30d, coalesce(rn.res_open, 0) AS res_open,
            coalesce(it.total, 0) AS total, coalesce(it.last30d, 0) AS last30d, coalesce(it.last_run, 0) AS last_run,
            coalesce(it.held, 0) AS held, coalesce(it.useful, 0) AS useful, coalesce(it.irrelevant, 0) AS irrelevant,
            coalesce(it.boring, 0) AS boring, coalesce(it.unrated, 0) AS unrated,
            coalesce(p.published, 0) AS res_published
       FROM interests i
       LEFT JOIN last_run l ON l.interest_id = i.id
       LEFT JOIN runs rn ON rn.interest_id = i.id
       LEFT JOIN items it ON it.interest_id = i.id
       LEFT JOIN pubs p ON p.interest_id = i.id
      WHERE i.id = ANY($1::uuid[])`,
    [ids, since, OPEN_RUN_STATUSES],
  );
  for (const x of r)
    out.set(x.id, {
      ...EMPTY_STATS,
      lastRunAt: iso(x.last_at),
      lastRun: x.last_id
        ? {
            id: x.last_id,
            kind: x.last_kind,
            status: x.last_status,
            found: x.last_found ?? null,
            published: x.last_published ?? null,
            cardRef: x.last_ref,
          }
        : null,
      runs30d: Number(x.runs30d),
      items: {
        total: Number(x.total),
        last30d: Number(x.last30d),
        lastRun: Number(x.last_run),
        held: Number(x.held),
      },
      ratings: {
        useful: Number(x.useful),
        irrelevant: Number(x.irrelevant),
        boring: Number(x.boring),
        unrated: Number(x.unrated),
      },
      research: { open: Number(x.res_open), published: Number(x.res_published) },
    });
  return out;
}

type AgentRef = { id: string; name: string; online: boolean };

async function agentRefs(db: Queryable, rowsIn: Row[], now: Date): Promise<Map<string, AgentRef>> {
  const ids = [
    ...new Set(
      rowsIn.flatMap((r) => Object.values((r.agents as Record<string, string>) ?? {}).filter(Boolean)),
    ),
  ];
  const out = new Map<string, AgentRef>();
  if (ids.length === 0) return out;
  for (const a of await rows(
    db,
    `SELECT a.id, a.name, (ws.connected AND ws.last_seen_at > $2) AS online
       FROM agents a JOIN workstations ws ON ws.id = a.workstation_id WHERE a.id = ANY($1::uuid[])`,
    [ids, new Date(now.getTime() - ONLINE_MS)],
  ))
    out.set(a.id, { id: a.id, name: a.name, online: Boolean(a.online) });
  return out;
}

async function tasteRuleCount(r: Row): Promise<number> {
  return Array.isArray(r.taste_rules) ? r.taste_rules.length : 0;
}

async function toDto(
  db: Queryable,
  r: Row,
  stats: InterestStats | undefined,
  agents: Map<string, AgentRef>,
): Promise<InterestDto> {
  const a = (r.agents ?? {}) as InterestAgents;
  const st = { ...(stats ?? EMPTY_STATS) };
  st.nextScanAt = r.status === 'active' && !r.archived_at ? iso(r.next_scan_at) : null;
  st.nextDeliveryAt = r.status === 'active' && !r.archived_at ? iso(r.next_delivery_at) : null;
  st.lastDeliveredAt = iso(r.last_delivered_at);
  st.failCount = Number(r.fail_count ?? 0);
  st.lastError = r.last_error ?? null;
  st.failing = st.failCount > 0 || st.lastRun?.status === 'failed';
  const scan = (r.scan as ScanSpec | null) ?? {
    cron: '0 7 * * *',
    timezone: 'UTC',
    windowHours: 24,
    maxItems: 10,
    manual: true,
  };
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    description: r.description ?? '',
    slug: r.slug ?? null,
    domain: r.domain ?? 'personal',
    vaultDir: r.project_vault_dir ?? null,
    hasVault: await projectHasVault(db, r.project_id),
    projectKey: r.project_key ?? null,
    subCategory: r.sub_category,
    preferredSites: r.preferred_sites ?? [],
    kinds: r.kinds ?? ['article', 'video', 'podcast'],
    scan,
    delivery: (r.delivery as DeliverySpec) ?? { mode: 'immediate', cron: '0 7 * * 1-5', timezone: 'UTC' },
    status: r.status,
    archived: Boolean(r.archived_at),
    agents: {
      scout: (a.scout && agents.get(a.scout)) || null,
      curator: (a.curator && agents.get(a.curator)) || null,
      researcher: (a.researcher && agents.get(a.researcher)) || null,
      checker: (a.checker && agents.get(a.checker)) || null,
    },
    canManage: Boolean(r.edit_ok),
    canShare: Boolean(r.can_share),
    createdBy: r.created_by ? { id: r.created_by, name: r.creator_name ?? 'Someone' } : null,
    tasteRuleCount: await tasteRuleCount(r),
    tasteVersion: Number(r.taste_version ?? 0),
    stats: st,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

export async function listInterests(
  db: Queryable,
  userId: string,
  now: Date,
  q: Query = { archived: false },
): Promise<InterestDto[]> {
  const r = await rows(
    db,
    `${SELECT} WHERE (($3::boolean AND i.archived_at IS NOT NULL) OR (NOT $3::boolean AND i.archived_at IS NULL))
        AND ($2::text IS NULL OR i.status = $2) ORDER BY lower(i.name), i.id`,
    [userId, q.status ?? null, q.archived],
  );
  const stats = await statsFor(
    db,
    r.map((x) => x.id),
    now,
  );
  const agents = await agentRefs(db, r, now);
  const out: InterestDto[] = [];
  for (const x of r) out.push(await toDto(db, x, stats.get(x.id), agents));
  await withCosts(db, out, r, now);
  return out;
}

/** Spend and budget of each interest's backing project (cost tracking); Owner and Admins may edit the budget. */
async function withCosts(db: Queryable, dtos: InterestDto[], raw: Row[], now: Date): Promise<void> {
  for (const orgId of new Set(dtos.map((d) => d.orgId))) {
    const c = await orgCostCtx(db, orgId);
    const mine = raw.filter((x) => x.org_id === orgId);
    const projectIds = mine.map((x) => x.project_id as string);
    const month = await monthSpendByProject(db, c, now, projectIds);
    const briefs = await spendBriefs(db, c, now, 'project', projectIds);
    for (const x of mine) {
      const dto = dtos.find((d) => d.id === x.id);
      if (!dto) continue;
      dto.budget = budgetDto(x, month.get(x.project_id) ?? 0, c, now, {
        canEdit: Boolean(x.can_share),
        showAmounts: true,
      });
      dto.spend = briefs.get(x.project_id);
    }
  }
}

export async function getInterestDto(
  db: Queryable,
  userId: string,
  id: string,
  now: Date,
): Promise<InterestDto | null> {
  const r = await one(db, `${SELECT} WHERE i.id = $2`, [userId, id]);
  if (!r) return null;
  const stats = await statsFor(db, [id], now);
  const dto = await toDto(db, r, stats.get(id), await agentRefs(db, [r], now));
  await withCosts(db, [dto], [r], now);
  return dto;
}

/** Detail: the interest, its notes, its taste and who can see it. */
export async function interestDetail(
  db: Queryable,
  userId: string,
  id: string,
  now: Date,
): Promise<InterestDetailResponse | null> {
  const interest = await getInterestDto(db, userId, id, now);
  if (!interest) return null;
  const row = (await one(db, 'SELECT * FROM interests WHERE id=$1', [id])) as Row;
  const pubs = await rows(
    db,
    `SELECT rp.id, rp.card_id, c.ref, rp.title, rp.vault_path, rp.created_at FROM research_publications rp
       JOIN cards c ON c.id = rp.card_id WHERE c.interest_id = $1 ORDER BY rp.event_seq DESC LIMIT 20`,
    [id],
  );
  const members = await rows(
    db,
    `SELECT pm.user_id, u.display_name, pm.role, pm.org_grant FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1 AND pm.status = 'active' ORDER BY pm.org_grant DESC, u.display_name`,
    [row.project_id],
  );
  return {
    interest,
    publications: pubs.map((p) => ({
      id: p.id,
      cardId: p.card_id,
      cardRef: p.ref,
      title: p.title,
      vaultPath: p.vault_path ?? null,
      createdAt: iso(p.created_at) as string,
    })),
    taste: {
      rules: ((row.taste_rules as string[]) ?? []).map(String),
      version: Number(row.taste_version ?? 0),
      hasVault: interest.hasVault,
      ratingLines: await ratingLines(db, row),
    },
    members: members.map((m) => ({
      userId: m.user_id,
      name: m.display_name,
      role: m.role,
      orgGrant: Boolean(m.org_grant),
    })),
  };
}

/**
 * The rating lines `taste.md` holds (verdicts and approved proposals), newest first. The site holds no vault content, so
 * this is rebuilt from the projection with the renderers `vault.write` used.
 */
async function ratingLines(db: Queryable, interest: Row): Promise<string[]> {
  const rated = await rows(
    db,
    `SELECT d.kind, d.title, d.source, d.url, d.verdict, d.verdict_reason, d.rated_at
       FROM digest_items d JOIN cards c ON c.id = d.card_id
      WHERE c.interest_id=$1 AND d.verdict IS NOT NULL ORDER BY d.rated_at DESC LIMIT 200`,
    [interest.id],
  );
  const approved = await rows(
    db,
    `SELECT body, answered_at FROM desk_items WHERE project_id=$1 AND subkind='taste_rule' AND status='answered'
        AND answer_option='approved' ORDER BY answered_at DESC LIMIT 100`,
    [interest.project_id],
  );
  return [
    ...rated.map((r) => ({
      at: new Date(r.rated_at).getTime(),
      line: renderTasteEntry({
        verdict: r.verdict as FeedVerdict,
        kind: r.kind,
        title: r.title,
        source: r.source,
        url: r.url,
        reason: r.verdict_reason,
      }).trimEnd(),
    })),
    ...approved.map((r) => ({
      at: new Date(r.answered_at).getTime(),
      line: renderTasteRule(r.body).trimEnd(),
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .map((e) => e.line);
}

/** A vault exists that the project's files go to (its own or the organization's vault of its domain). */
export async function projectHasVault(db: Queryable, projectId: string): Promise<boolean> {
  const p = await one(db, 'SELECT org_id, domain FROM projects WHERE id=$1', [projectId]);
  if (!p) return false;
  const v =
    (await one(db, 'SELECT 1 AS x FROM vaults WHERE project_id=$1', [projectId])) ??
    (await one(db, 'SELECT 1 AS x FROM vaults WHERE org_id=$1 AND kind=$2 AND project_id IS NULL', [
      p.org_id,
      p.domain,
    ]));
  return Boolean(v);
}

// ------------------------------------------------------------------------------------------------ the run log

const RUN_SELECT = `
  SELECT r.*, c.ref AS card_ref, u.display_name AS starter_name,
         coalesce(rt.useful, 0) AS useful, coalesce(rt.irrelevant, 0) AS irrelevant, coalesce(rt.boring, 0) AS boring,
         coalesce(rt.unrated, 0) AS unrated,
         ARRAY(SELECT ch.id FROM interest_runs ch WHERE ch.parent_run_id = r.id ORDER BY ch.started_at) AS child_ids
    FROM interest_runs r JOIN cards c ON c.id = r.card_id LEFT JOIN users u ON u.id = r.started_by
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE d.verdict = 'useful') AS useful,
             count(*) FILTER (WHERE d.verdict = 'irrelevant') AS irrelevant,
             count(*) FILTER (WHERE d.verdict = 'boring') AS boring,
             count(*) FILTER (WHERE d.verdict IS NULL AND d.delivered_at IS NOT NULL) AS unrated
        FROM digest_items d WHERE d.card_id = r.card_id) rt ON true`;

const toRunDto = (r: Row): InterestRunDto => ({
  id: r.id,
  kind: r.kind,
  trigger: r.trigger,
  status: r.status,
  startedAt: iso(r.started_at) as string,
  finishedAt: iso(r.finished_at),
  found: r.found ?? null,
  published: r.published ?? null,
  duplicatesDropped: r.duplicates_dropped ?? null,
  overMaxDropped: r.over_max_dropped ?? null,
  startedBy: r.started_by ? { id: r.started_by, name: r.starter_name ?? 'Someone' } : null,
  ratings: {
    useful: Number(r.useful),
    irrelevant: Number(r.irrelevant),
    boring: Number(r.boring),
    unrated: Number(r.unrated),
  },
  card: { id: r.card_id, ref: r.card_ref },
  parentRunId: r.parent_run_id ?? null,
  childRunIds: r.child_ids ?? [],
});

async function canSee(db: Queryable, userId: string, interestId: string): Promise<boolean> {
  return Boolean(
    await one(
      db,
      `SELECT 1 FROM interests i JOIN project_members pm ON pm.project_id = i.project_id
        AND pm.user_id = $1 AND pm.status = 'active' WHERE i.id = $2`,
      [userId, interestId],
    ),
  );
}

export async function interestRuns(
  db: Queryable,
  userId: string,
  interestId: string,
  q: RunsQuery,
): Promise<{ runs: InterestRunDto[]; hasMore: boolean } | null> {
  if (!(await canSee(db, userId, interestId))) return null;
  const r = await rows(
    db,
    `${RUN_SELECT} WHERE r.interest_id = $1 AND ($2::timestamptz IS NULL OR r.started_at < $2)
        AND ($3::text IS NULL OR r.kind = $3) ORDER BY r.started_at DESC, r.id DESC LIMIT $4`,
    [interestId, q.before ?? null, q.kind ?? null, q.limit + 1],
  );
  return { runs: r.slice(0, q.limit).map(toRunDto), hasMore: r.length > q.limit };
}

export async function interestRunDetail(
  db: Queryable,
  userId: string,
  interestId: string,
  runId: string,
): Promise<InterestRunDetailResponse | null> {
  if (!(await canSee(db, userId, interestId))) return null;
  const run = await one(db, `${RUN_SELECT} WHERE r.interest_id = $1 AND r.id = $2`, [interestId, runId]);
  if (!run) return null;
  const items = await rows(db, `SELECT * FROM digest_items WHERE card_id = $1 ORDER BY event_seq, position`, [
    run.card_id,
  ]);
  const notes = await rows(
    db,
    `SELECT rp.id, rp.card_id, c.ref, rp.title, rp.vault_path, rp.created_at FROM research_publications rp
       JOIN cards c ON c.id = rp.card_id WHERE rp.card_id = $1 ORDER BY rp.event_seq`,
    [run.card_id],
  );
  const shifts = await rows(
    db,
    `SELECT s.id, s.stage, s.status, s.started_at, s.ended_at, a.name AS agent_name, a.role_key
       FROM shifts s JOIN agents a ON a.id = s.agent_id WHERE s.card_id = $1 AND s.kind = 'card'
      ORDER BY s.started_at`,
    [run.card_id],
  );
  return {
    run: toRunDto(run),
    items: items.map((d) => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      url: d.url,
      source: d.source,
      summary: d.summary,
      verdict: d.verdict ?? null,
      verdictReason: d.verdict_reason ?? null,
      transcript: d.transcript ?? null,
      delivered: d.delivered_at != null,
    })),
    notes: notes.map((p) => ({
      id: p.id,
      cardId: p.card_id,
      cardRef: p.ref,
      title: p.title,
      vaultPath: p.vault_path ?? null,
      createdAt: iso(p.created_at) as string,
    })),
    shifts: shifts.map((s) => ({
      id: s.id,
      role: s.role_key ?? null,
      agentName: s.agent_name ?? null,
      status: s.status,
      startedAt: iso(s.started_at),
      endedAt: iso(s.ended_at),
    })),
  };
}

export async function interestDeliveries(db: Queryable, userId: string, interestId: string) {
  if (!(await canSee(db, userId, interestId))) return null;
  const r = await rows(
    db,
    `SELECT * FROM interest_deliveries WHERE interest_id = $1 ORDER BY at DESC LIMIT 30`,
    [interestId],
  );
  return {
    deliveries: r.map((d) => ({
      id: d.id,
      at: iso(d.at) as string,
      itemCount: Number(d.item_count),
      heldBack: Number(d.held_back),
      trigger: d.trigger,
      deskItemId: d.desk_item_id ?? null,
    })),
  };
}

/**
 * Agents that qualify for the interest by role: active agents of its organization with the role, whose workstation
 * owner sees the backing project, and (an agent with a restricted project list works an interest only when assigned to
 * it, so that is allowed here too).
 */
export async function eligibleAgents(
  db: Queryable,
  userId: string,
  interestId: string,
  now: Date,
): Promise<EligibleAgentsResponse | null> {
  const i = await one(
    db,
    `SELECT i.org_id, i.project_id FROM interests i JOIN project_members pm ON pm.project_id = i.project_id
       AND pm.user_id = $1 AND pm.status = 'active' WHERE i.id = $2`,
    [userId, interestId],
  );
  if (!i) return null;
  const r = await rows(
    db,
    `SELECT a.id, a.name, a.role_key, (ws.connected AND ws.last_seen_at > $3) AS online
       FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
      WHERE a.org_id = $1 AND a.status <> 'retired' AND NOT a.is_devops
        AND a.role_key IN ('scout','curator','researcher','checker')
        AND EXISTS (SELECT 1 FROM project_members apm WHERE apm.project_id = $2 AND apm.user_id = ws.user_id AND apm.status = 'active')
      ORDER BY lower(a.name)`,
    [i.org_id, i.project_id, new Date(now.getTime() - ONLINE_MS)],
  );
  const by = (role: string) =>
    r.filter((a) => a.role_key === role).map((a) => ({ id: a.id, name: a.name, online: Boolean(a.online) }));
  return { scout: by('scout'), curator: by('curator'), researcher: by('researcher'), checker: by('checker') };
}

/** The interest's running list across all its runs, oldest first (the digest tab). */
export async function interestItems(
  db: Queryable,
  userId: string,
  interestId: string,
  status: 'unrated' | 'all',
) {
  if (!(await canSee(db, userId, interestId))) return null;
  return rows(
    db,
    `SELECT i.*, c.ref AS card_ref, p.key AS project_key FROM digest_items i
       JOIN cards c ON c.id = i.card_id JOIN projects p ON p.id = i.project_id
      WHERE c.interest_id = $1 AND i.delivered_at IS NOT NULL AND ($2 = 'all' OR i.verdict IS NULL)
      ORDER BY i.event_seq, i.position`,
    [interestId, status],
  );
}
