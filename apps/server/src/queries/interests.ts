import type {
  InterestDetailResponse,
  InterestDto,
  InterestStats,
  InterestsQuerySchema,
  ScanSpec,
  TasteSeedLine,
} from '@aom/shared';
import type { z } from 'zod';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';

type Query = z.infer<typeof InterestsQuerySchema>;

const VISIBLE_IDS = `SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active'`;

const NO_STATS: InterestStats = {
  lastScanAt: null,
  lastScanCard: null,
  nextScanAt: null,
  scans30d: 0,
  items: { total: 0, last30d: 0, lastScan: 0 },
  ratings: { useful: 0, irrelevant: 0, boring: 0, unrated: 0 },
  research: { open: 0, published: 0 },
  failing: false,
};

const SELECT = `
  SELECT i.*,
         fp.key AS feed_key, fp.name AS feed_name, fp.status AS feed_status,
         rp.key AS research_key, rp.name AS research_name, rp.status AS research_status,
         s.enabled AS sched_enabled, s.next_fire_at AS sched_next, s.fail_count AS sched_fail, s.last_error AS sched_error,
         s.last_fired_at AS sched_last_fired,
         (fm.user_id IS NOT NULL OR i.feed_project_id IS NULL) AS feed_member,
         (rm.user_id IS NOT NULL OR i.research_project_id IS NULL) AS research_member,
         (SELECT count(*) FROM taste_seeds ts, jsonb_array_elements(ts.rules) r
           WHERE ts.project_id = i.feed_project_id AND r->>'interestId' = i.id::text) AS taste_rules
    FROM interests i
    LEFT JOIN projects fp ON fp.id = i.feed_project_id
    LEFT JOIN projects rp ON rp.id = i.research_project_id
    LEFT JOIN schedules s ON s.id = i.schedule_id
    LEFT JOIN project_members fm ON fm.project_id = i.feed_project_id AND fm.user_id = $1 AND fm.status = 'active'
    LEFT JOIN project_members rm ON rm.project_id = i.research_project_id AND rm.user_id = $1 AND rm.status = 'active'`;

const SEE = `(i.feed_project_id IN (${VISIBLE_IDS}) OR i.research_project_id IN (${VISIBLE_IDS}))`;

/** Stats for the given interests in one query round (CTEs grouped by `cards.interest_id`). */
async function statsFor(db: Queryable, ids: string[], now: Date): Promise<Map<string, InterestStats>> {
  const out = new Map<string, InterestStats>();
  if (ids.length === 0) return out;
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const r = await rows(
    db,
    `WITH feed_cards AS (
       SELECT c.interest_id, c.id, c.ref, c.status, c.created_at FROM cards c
        WHERE c.interest_id = ANY($1::uuid[]) AND c.card_type = 'feed'
     ), last_scan AS (
       SELECT DISTINCT ON (interest_id) interest_id, id, ref, status, created_at FROM feed_cards
        ORDER BY interest_id, created_at DESC, id DESC
     ), scans AS (
       SELECT interest_id, count(*) FILTER (WHERE created_at >= $2) AS scans30d FROM feed_cards GROUP BY interest_id
     ), items AS (
       SELECT c.interest_id,
              count(*) AS total,
              count(*) FILTER (WHERE d.created_at >= $2) AS last30d,
              count(*) FILTER (WHERE d.card_id = l.id) AS last_scan,
              count(*) FILTER (WHERE d.verdict = 'useful') AS useful,
              count(*) FILTER (WHERE d.verdict = 'irrelevant') AS irrelevant,
              count(*) FILTER (WHERE d.verdict = 'boring') AS boring,
              count(*) FILTER (WHERE d.verdict IS NULL) AS unrated
         FROM digest_items d JOIN cards c ON c.id = d.card_id
         LEFT JOIN last_scan l ON l.interest_id = c.interest_id
        WHERE c.interest_id = ANY($1::uuid[]) GROUP BY c.interest_id
     ), research AS (
       SELECT c.interest_id,
              count(*) FILTER (WHERE c.status NOT IN ('done','cancelled')) AS open
         FROM cards c WHERE c.interest_id = ANY($1::uuid[]) AND c.card_type = 'research' GROUP BY c.interest_id
     ), pubs AS (
       SELECT c.interest_id, count(*) AS published FROM research_publications rp JOIN cards c ON c.id = rp.card_id
        WHERE c.interest_id = ANY($1::uuid[]) GROUP BY c.interest_id
     )
     SELECT i.id, l.id AS last_id, l.ref AS last_ref, l.status AS last_status, l.created_at AS last_at,
            coalesce(sc.scans30d, 0) AS scans30d,
            coalesce(it.total, 0) AS total, coalesce(it.last30d, 0) AS last30d, coalesce(it.last_scan, 0) AS last_scan,
            coalesce(it.useful, 0) AS useful, coalesce(it.irrelevant, 0) AS irrelevant, coalesce(it.boring, 0) AS boring,
            coalesce(it.unrated, 0) AS unrated,
            coalesce(rs.open, 0) AS res_open, coalesce(p.published, 0) AS res_published
       FROM interests i
       LEFT JOIN last_scan l ON l.interest_id = i.id
       LEFT JOIN scans sc ON sc.interest_id = i.id
       LEFT JOIN items it ON it.interest_id = i.id
       LEFT JOIN research rs ON rs.interest_id = i.id
       LEFT JOIN pubs p ON p.interest_id = i.id
      WHERE i.id = ANY($1::uuid[])`,
    [ids, since],
  );
  for (const x of r)
    out.set(x.id, {
      lastScanAt: iso(x.last_at),
      lastScanCard: x.last_id ? { id: x.last_id, ref: x.last_ref, status: x.last_status } : null,
      nextScanAt: null,
      scans30d: Number(x.scans30d),
      items: { total: Number(x.total), last30d: Number(x.last30d), lastScan: Number(x.last_scan) },
      ratings: {
        useful: Number(x.useful),
        irrelevant: Number(x.irrelevant),
        boring: Number(x.boring),
        unrated: Number(x.unrated),
      },
      research: { open: Number(x.res_open), published: Number(x.res_published) },
      failing: false,
    });
  return out;
}

function toDto(r: Row, stats: InterestStats | undefined): InterestDto {
  const st = { ...(stats ?? NO_STATS) };
  st.nextScanAt = r.sched_enabled ? iso(r.sched_next) : null;
  st.failing = (r.sched_fail ?? 0) > 0;
  const member = Boolean(r.feed_member) && Boolean(r.research_member);
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    description: r.description,
    feedProject: r.feed_project_id
      ? { id: r.feed_project_id, key: r.feed_key, name: r.feed_name, archived: r.feed_status !== 'active' }
      : null,
    researchProject: r.research_project_id
      ? {
          id: r.research_project_id,
          key: r.research_key,
          name: r.research_name,
          archived: r.research_status !== 'active',
        }
      : null,
    subCategory: r.sub_category,
    preferredSites: r.preferred_sites ?? [],
    scan: (r.scan as ScanSpec | null) ?? null,
    status: r.status,
    scheduleId: r.schedule_id,
    adoptedFrom: r.adopted_from,
    canManage: member,
    canRun: Boolean(r.feed_project_id) && Boolean(r.feed_member),
    canResearch: Boolean(r.research_project_id) && Boolean(r.research_member),
    tasteRuleCount: Number(r.taste_rules ?? 0),
    schedule:
      r.schedule_id && r.sched_next !== undefined && r.sched_enabled !== null
        ? {
            id: r.schedule_id,
            enabled: Boolean(r.sched_enabled),
            nextFireAt: iso(r.sched_next),
            failCount: Number(r.sched_fail ?? 0),
            lastError: r.sched_error ?? null,
          }
        : null,
    stats: st,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

export async function listInterests(
  db: Queryable,
  userId: string,
  now: Date,
  q: Query = {},
): Promise<InterestDto[]> {
  const r = await rows(
    db,
    `${SELECT} WHERE ${SEE} AND ($2::uuid IS NULL OR i.feed_project_id = $2 OR i.research_project_id = $2)
        AND ($3::text IS NULL OR i.status = $3) ORDER BY lower(i.name), i.id`,
    [userId, q.projectId ?? null, q.status ?? null],
  );
  const stats = await statsFor(
    db,
    r.map((x) => x.id),
    now,
  );
  return r.map((x) => toDto(x, stats.get(x.id)));
}

export async function getInterestDto(
  db: Queryable,
  userId: string,
  id: string,
  now: Date,
): Promise<InterestDto | null> {
  const r = await one(db, `${SELECT} WHERE ${SEE} AND i.id = $2`, [userId, id]);
  if (!r) return null;
  const stats = await statsFor(db, [id], now);
  return toDto(r, stats.get(id));
}

/** Detail: the interest, its last scans and notes, and its own taste rules. */
export async function interestDetail(
  db: Queryable,
  userId: string,
  id: string,
  now: Date,
): Promise<InterestDetailResponse | null> {
  const interest = await getInterestDto(db, userId, id, now);
  if (!interest) return null;
  const scans = await rows(
    db,
    `SELECT c.id, c.ref, c.status, c.created_at,
            (SELECT count(*) FROM digest_items d WHERE d.card_id = c.id) AS items,
            EXISTS (SELECT 1 FROM events e WHERE e.type = 'DigestPosted' AND e.stream_id = 'card-' || c.id::text
                      AND (e.payload->>'nothingQualified')::boolean) AS nothing
       FROM cards c WHERE c.interest_id = $1 AND c.card_type = 'feed' ORDER BY c.created_at DESC, c.id DESC LIMIT 5`,
    [id],
  );
  const pubs = await rows(
    db,
    `SELECT rp.id, rp.card_id, c.ref, rp.title, rp.created_at FROM research_publications rp
       JOIN cards c ON c.id = rp.card_id WHERE c.interest_id = $1 ORDER BY rp.event_seq DESC LIMIT 5`,
    [id],
  );
  const seed = interest.feedProject
    ? await one(db, 'SELECT version, rules FROM taste_seeds WHERE project_id=$1', [interest.feedProject.id])
    : undefined;
  const rules = ((seed?.rules as TasteSeedLine[] | undefined) ?? [])
    .filter((r) => r.interestId === id)
    .map((r) => r.text);
  const hasVault = interest.feedProject ? await projectHasVault(db, interest.feedProject.id) : false;
  return {
    interest,
    scans: scans.map((s) => ({
      cardId: s.id,
      ref: s.ref,
      status: s.status,
      firedAt: iso(s.created_at) as string,
      items: Number(s.items),
      nothingQualified: Boolean(s.nothing),
    })),
    publications: pubs.map((p) => ({
      id: p.id,
      cardId: p.card_id,
      cardRef: p.ref,
      title: p.title,
      createdAt: iso(p.created_at) as string,
    })),
    taste: { rules, version: Number(seed?.version ?? 0), hasVault },
  };
}

/** A vault exists that a feed project's files go to (its own or the owner's vault of its domain). */
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

/** Unlinked feed schedules in the user's projects (the adopt banner). */
export async function adoptableSchedules(db: Queryable, userId: string) {
  const r = await rows(
    db,
    `SELECT s.*, p.key AS project_key FROM schedules s JOIN projects p ON p.id = s.project_id
      WHERE s.kind = 'feed' AND s.interest_id IS NULL AND p.status = 'active'
        AND s.project_id IN (${VISIBLE_IDS}) ORDER BY p.key, s.created_at, s.id`,
    [userId],
  );
  return r.map((s) => ({
    id: s.id as string,
    name: s.name as string,
    projectId: s.project_id as string,
    projectKey: s.project_key as string,
    cron: s.cron as string,
    timezone: s.timezone as string,
    enabled: Boolean(s.enabled),
    topic:
      typeof s.card_template?.fields?.topic === 'string' ? (s.card_template.fields.topic as string) : null,
  }));
}

/** Feed projects the user belongs to that have explicit rules, or that have interests: the "Project taste rules" panel. */
export async function tasteProjects(db: Queryable, userId: string) {
  const r = await rows(
    db,
    `SELECT p.id, p.key, p.name, coalesce(jsonb_array_length(ts.rules), 0) AS rule_count, coalesce(ts.version, 0) AS version
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active'
       LEFT JOIN taste_seeds ts ON ts.project_id = p.id
      WHERE p.status = 'active' AND EXISTS (SELECT 1 FROM interests i WHERE i.feed_project_id = p.id)
      ORDER BY p.key`,
    [userId],
  );
  const out = [];
  for (const x of r)
    out.push({
      projectId: x.id as string,
      key: x.key as string,
      name: x.name as string,
      ruleCount: Number(x.rule_count),
      version: Number(x.version),
      hasVault: await projectHasVault(db, x.id),
      canManage: true,
    });
  return out;
}
