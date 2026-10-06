import { randomUUID } from 'node:crypto';
import {
  type CardTemplate,
  type CreateInterestRequest,
  canCreateProject,
  canEditInterest,
  defaultWindowHours,
  effectiveCreatorRank,
  feedMaxItems,
  type InterestBody,
  interestCardTemplate,
  type OrgRole,
  type PatchInterestRequest,
  type ScanSpec,
  type ScheduleSyncPlan,
  scheduleEnabled,
  scheduleSyncPlan,
  streamId,
  type TasteSeedLine,
} from '@aom/shared';
import { rankInOrg } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { projectRole } from '../authz/scope.ts';
import { resolveWorkflow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { assertWithinLimit } from '../orgs/limits.ts';
import { projectScope, userActor } from './common.ts';
import { assertCronAndZone, checkTemplate, nextFireAfter, scheduleUpdateEvent } from './schedules.ts';

/**
 * Interest commands (docs/design/interests.md section 4). The interest owns its feed schedule: every command appends the
 * `Schedule*` events it needs in the same transaction, so the scheduler is unchanged. Who may manage an interest (owner
 * decision, provisional: any member, like phases): an active member of its feed project and of its research project.
 */

type User = AuthSession['user'];

const DEFAULT_CRON = '0 7 * * *';

/** The row as the `InterestBody` snapshot the events carry. */
export function interestBody(r: Row): InterestBody {
  return {
    interestId: r.id,
    orgId: r.org_id,
    name: r.name,
    description: r.description ?? '',
    feedProjectId: r.feed_project_id ?? null,
    researchProjectId: r.research_project_id ?? null,
    subCategory: r.sub_category ?? null,
    preferredSites: r.preferred_sites ?? [],
    scan: (r.scan as ScanSpec | null) ?? null,
    status: r.status,
    scheduleId: r.schedule_id ?? null,
    ...(r.adopted_from ? { adoptedFrom: r.adopted_from } : {}),
  };
}

/** The viewer's membership of an interest's projects: a member of every project it links. */
export async function canManageInterest(db: Queryable, userId: string, i: Row): Promise<boolean> {
  let any = false;
  for (const pid of [i.feed_project_id, i.research_project_id]) {
    if (!pid) continue;
    any = true;
    if (!(await projectRole(db, userId, pid))) return false;
  }
  return any;
}

/** Loads a linked project: the user must be an active member, the project active, and of the right field set. */
async function loadProjectFor(
  tx: Queryable,
  user: User,
  projectId: string,
  fieldSet: 'feed' | 'research',
  opts: { allowArchived?: boolean } = {},
): Promise<Row> {
  const p = await one(
    tx,
    `SELECT p.*, pm.role AS my_role FROM projects p JOIN project_members pm
       ON pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active' WHERE p.id = $2`,
    [user.id, projectId],
  );
  if (!p) throw notFound('project not found');
  if (p.status !== 'active' && !opts.allowArchived) throw conflict('project_archived', 'project is archived');
  const wf = await resolveWorkflow(tx, p.org_id, p.workflow_key);
  if (wf?.definition.fieldSet !== fieldSet)
    throw badRequest(
      fieldSet === 'feed' ? 'not_a_feed_project' : 'not_a_research_project',
      fieldSet === 'feed'
        ? 'the feed project needs the feed workflow'
        : 'the research project needs a research workflow',
    );
  return p;
}

function resolveScan(
  cron: string | undefined,
  timezone: string | undefined,
  windowHours: number | undefined,
  maxItems: number | undefined,
  manual: boolean | undefined,
  fallback?: ScanSpec | null,
): ScanSpec {
  const c = (cron ?? fallback?.cron ?? DEFAULT_CRON).trim();
  const z = timezone ?? fallback?.timezone ?? 'UTC';
  assertCronAndZone(c, z);
  const keepWindow = fallback && c === fallback.cron.trim() ? fallback.windowHours : undefined;
  // A window that was the cadence's default follows the cadence when only the cron changes.
  const followed =
    fallback && c !== fallback.cron.trim() && fallback.windowHours === defaultWindowHours(fallback.cron)
      ? defaultWindowHours(c)
      : fallback?.windowHours;
  return {
    cron: c,
    timezone: z,
    windowHours: windowHours ?? keepWindow ?? followed ?? defaultWindowHours(c),
    maxItems: maxItems ?? fallback?.maxItems ?? 10,
    manual: manual ?? fallback?.manual ?? false,
  };
}

async function assertNameFree(db: Queryable, orgId: string, name: string, exceptId?: string): Promise<void> {
  const taken = await one(
    db,
    'SELECT id FROM interests WHERE org_id=$1 AND lower(name)=lower($2) AND ($3::uuid IS NULL OR id <> $3)',
    [orgId, name, exceptId ?? null],
  );
  if (taken) throw conflict('interest_name_taken', `an interest named "${name}" already exists`);
}

/** The owner of a project adds a new sub-category to it (members cannot change project settings). */
function subCategoryEvent(project: Row, subCategory: string | null, user: User): AppendInput | null {
  if (!subCategory || project.my_role !== 'owner') return null;
  const known = (project.sub_categories as string[] | null) ?? [];
  if (known.includes(subCategory)) return null;
  return {
    streamId: streamId.project(project.id),
    event: {
      type: 'ProjectUpdated',
      payload: { projectId: project.id, changes: { subCategories: [...known, subCategory] } },
    },
    actor: userActor(user.id),
    scope: projectScope(project.org_id, project.id),
  };
}

function scheduleCreatedEvent(
  body: InterestBody,
  scheduleId: string,
  project: Row,
  now: Date,
  user: User | null,
): AppendInput {
  const scan = body.scan as ScanSpec;
  const enabled = scheduleEnabled(body);
  return {
    streamId: streamId.schedule(scheduleId),
    event: {
      type: 'ScheduleCreated',
      payload: {
        scheduleId,
        projectId: project.id,
        interestId: body.interestId,
        name: body.name,
        kind: 'feed',
        cron: scan.cron,
        timezone: scan.timezone,
        cardTemplate: interestCardTemplate(body),
        enabled,
        nextFireAt: enabled ? (nextFireAfter(scan.cron, scan.timezone, now)?.toISOString() ?? null) : null,
      },
    },
    actor: user ? userActor(user.id) : { kind: 'system', id: null },
    scope: projectScope(project.org_id, project.id),
  };
}

export async function createInterest(
  ctx: Ctx,
  user: User,
  org: { id: string; role: OrgRole | null },
  req: CreateInterestRequest,
): Promise<string> {
  if (req.feedProjectId && req.newFeedProject)
    throw badRequest('conflicting_feed_project', 'choose an existing feed project or a new one, not both');
  if (!req.feedProjectId && !req.newFeedProject && !req.researchProjectId)
    throw badRequest(
      'interest_needs_project',
      'an interest needs a feed project, a research project or both',
    );
  const interestId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    const events: AppendInput[] = [];
    let feed: Row | undefined;
    if (req.newFeedProject) {
      const np = req.newFeedProject;
      // A new project is created: only the Owner and Admins do that (owner decision 4).
      if (!canCreateProject({ orgRole: org.role }))
        throw forbidden(
          'only the organization Owner and Admins can create a project: choose an existing feed project',
        );
      await assertWithinLimit(tx, org.id, 'projects');
      if (!(await resolveWorkflow(tx, org.id, 'feed')))
        throw badRequest('unknown_workflow', "workflow 'feed' does not exist");
      if (await one(tx, 'SELECT 1 FROM projects WHERE org_id=$1 AND key=$2', [org.id, np.key]))
        throw conflict('project_key_taken', `project key ${np.key} is already in use`);
      const projectId = randomUUID();
      const created: AppendInput = {
        streamId: streamId.project(projectId),
        event: {
          type: 'ProjectCreated',
          payload: {
            projectId,
            orgId: org.id,
            createdByUserId: user.id,
            key: np.key,
            name: np.name,
            domain: np.domain,
            workflowKey: 'feed',
            priorityTier: 2,
            branchPrefix: 'aom/',
            workingBranch: 'main',
            subCategories: [],
            vaultFolder: null,
          },
        },
        actor: userActor(user.id),
        scope: projectScope(org.id, projectId),
      };
      // Its projector runs inside this transaction, so the project row exists for the steps below.
      await ctx.store.append([created], { tx });
      feed = await loadProjectFor(tx, user, projectId, 'feed');
    } else if (req.feedProjectId) {
      feed = await loadProjectFor(tx, user, req.feedProjectId, 'feed');
    }
    const research = req.researchProjectId
      ? await loadProjectFor(tx, user, req.researchProjectId, 'research')
      : undefined;
    if (feed && research && feed.org_id !== research.org_id)
      throw badRequest(
        'projects_differ_in_org',
        'the feed and research projects must belong to the same organization',
      );
    const orgId = (feed ?? research)?.org_id as string;
    await assertNameFree(tx, orgId, req.name);

    const scan = feed
      ? resolveScan(
          req.scan?.cron,
          req.scan?.timezone,
          req.scan?.windowHours,
          req.scan?.maxItems,
          req.scan?.manual,
        )
      : null;
    const scheduleId = feed ? randomUUID() : null;
    const body: InterestBody = {
      interestId,
      orgId,
      creatorRank: ((await rankInOrg(tx, user.id, orgId)) || 1) as 1 | 2 | 3 | 4,
      name: req.name,
      description: req.description,
      feedProjectId: feed?.id ?? null,
      researchProjectId: research?.id ?? null,
      subCategory: req.subCategory ?? null,
      preferredSites: req.preferredSites,
      scan,
      status: req.status,
      scheduleId,
    };
    if (feed) {
      // A bad template must fail now, not at 07:00.
      await checkTemplate(tx, feed, 'feed', interestCardTemplate(body));
    }
    const owned = research ?? feed;
    const subEvent = owned ? subCategoryEvent(owned, req.subCategory ?? null, user) : null;
    if (subEvent) events.push(subEvent);
    events.push({
      streamId: streamId.interest(interestId),
      event: { type: 'InterestCreated', payload: body },
      actor: userActor(user.id),
      scope: projectScope(orgId, (feed ?? research)?.id as string),
    });
    if (feed && scheduleId) events.push(scheduleCreatedEvent(body, scheduleId, feed, ctx.clock.now(), user));
    await ctx.store.append(events, { tx });
  });
  return interestId;
}

/**
 * Edit rule of an interest (owner decision 13, docs/design/organizations.md section 4.3): the creator, or someone of
 * at least the creator's rank in the interest's organization. The creator's current rank counts while they still have
 * a relationship with the organization; the rank stored at creation is the fallback once they left.
 */
export async function assertCanEditInterest(tx: Queryable, userId: string, i: Row): Promise<void> {
  const actorRank = await rankInOrg(tx, userId, i.org_id);
  const current = i.created_by ? await rankInOrg(tx, i.created_by, i.org_id) : 0;
  const creatorRank = effectiveCreatorRank(current, i.created_by_rank ?? undefined);
  if (
    !canEditInterest({ userId, rank: actorRank }, { userId: i.created_by ?? null, rank: creatorRank }, true)
  )
    throw forbidden(
      'only its creator, or someone of a higher role in the organization, can change this interest',
    );
}

async function lockInterest(tx: Tx, user: User, id: string): Promise<Row> {
  const i = await one(tx, 'SELECT * FROM interests WHERE id=$1 FOR UPDATE', [id]);
  if (!i) throw notFound('interest not found');
  // Not visible looks like not found; visible but not a member of every linked project is forbidden.
  let member = false;
  for (const pid of [i.feed_project_id, i.research_project_id])
    if (pid && (await projectRole(tx, user.id, pid))) member = true;
  if (!member) throw notFound('interest not found');
  if (!(await canManageInterest(tx, user.id, i)))
    throw forbidden('you must be a member of every project this interest links to');
  await assertCanEditInterest(tx, user.id, i);
  return i;
}

/**
 * The schedule events an interest edit needs (section 4.3). The pure plan decides the project-level changes; for the
 * schedule that stays, the row is compared with what the interest implies, so the first edit of an adopted interest
 * normalizes its template.
 */
async function syncSchedule(
  tx: Tx,
  ctx: Ctx,
  user: User,
  before: InterestBody,
  after: InterestBody,
): Promise<{ events: AppendInput[]; scheduleId: string | null }> {
  const plan: ScheduleSyncPlan = scheduleSyncPlan(before, after);
  const events: AppendInput[] = [];
  const now = ctx.clock.now();
  const feedId = after.feedProjectId;
  const newProject = feedId ? await one(tx, 'SELECT * FROM projects WHERE id=$1', [feedId]) : undefined;
  const oldSchedule = before.scheduleId
    ? await one(tx, 'SELECT * FROM schedules WHERE id=$1 FOR UPDATE', [before.scheduleId])
    : undefined;
  const removeOld = (): void => {
    if (!oldSchedule) return;
    events.push({
      streamId: streamId.schedule(oldSchedule.id),
      event: { type: 'ScheduleDeleted', payload: { scheduleId: oldSchedule.id } },
      actor: userActor(user.id),
      scope: projectScope(oldSchedule.org_id, oldSchedule.project_id),
    });
  };
  if (plan.action === 'delete') {
    removeOld();
    return { events, scheduleId: null };
  }
  if (plan.action === 'create' || plan.action === 'replace' || (feedId && !oldSchedule)) {
    if (plan.action === 'replace') removeOld();
    const scheduleId = randomUUID();
    events.push(scheduleCreatedEvent({ ...after, scheduleId }, scheduleId, newProject as Row, now, user));
    return { events, scheduleId };
  }
  if (!oldSchedule) return { events, scheduleId: null };
  // The schedule stays: bring it to what the interest implies.
  const scan = after.scan as ScanSpec;
  const desired = {
    name: after.name,
    cron: scan.cron,
    timezone: scan.timezone,
    cardTemplate: interestCardTemplate(after),
    enabled: scheduleEnabled(after),
  };
  const differs =
    oldSchedule.name !== desired.name ||
    oldSchedule.cron !== desired.cron ||
    oldSchedule.timezone !== desired.timezone ||
    oldSchedule.enabled !== desired.enabled ||
    JSON.stringify(oldSchedule.card_template) !== JSON.stringify(desired.cardTemplate);
  if (differs || plan.action === 'update') {
    const reschedule =
      (plan.action === 'update' && plan.reschedule) ||
      oldSchedule.cron !== desired.cron ||
      oldSchedule.timezone !== desired.timezone ||
      (desired.enabled && !oldSchedule.enabled);
    events.push(
      scheduleUpdateEvent(oldSchedule, newProject as Row, desired, reschedule, now, userActor(user.id)),
    );
  }
  return { events, scheduleId: oldSchedule.id };
}

export async function updateInterest(
  ctx: Ctx,
  user: User,
  id: string,
  patch: PatchInterestRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const row = await lockInterest(tx, user, id);
    const before = interestBody(row);
    const feedId = patch.feedProjectId !== undefined ? patch.feedProjectId : before.feedProjectId;
    const researchId =
      patch.researchProjectId !== undefined ? patch.researchProjectId : before.researchProjectId;
    if (!feedId && !researchId)
      throw badRequest(
        'interest_needs_project',
        'an interest needs a feed project, a research project or both',
      );
    // Newly linked projects are checked (member, active, right kind); unchanged ones may be archived.
    const feed = feedId
      ? await loadProjectFor(tx, user, feedId, 'feed', { allowArchived: feedId === before.feedProjectId })
      : undefined;
    const research = researchId
      ? await loadProjectFor(tx, user, researchId, 'research', {
          allowArchived: researchId === before.researchProjectId,
        })
      : undefined;
    if (feed && research && feed.org_id !== research.org_id)
      throw badRequest(
        'projects_differ_in_org',
        'the feed and research projects must belong to the same organization',
      );
    const name = patch.name ?? before.name;
    if (name.toLowerCase() !== before.name.toLowerCase()) await assertNameFree(tx, before.orgId, name, id);
    const status = patch.status ?? before.status;
    if (
      status === 'active' &&
      feed &&
      feed.status !== 'active' &&
      (before.status !== 'active' || feed.id !== before.feedProjectId)
    )
      throw conflict(
        'project_archived',
        'the feed project is archived; restore it before resuming this interest',
      );
    const scan = feed
      ? resolveScan(
          patch.scan?.cron,
          patch.scan?.timezone,
          patch.scan?.windowHours,
          patch.scan?.maxItems,
          patch.scan?.manual,
          before.scan,
        )
      : null;
    const after: InterestBody = {
      ...before,
      name,
      description: patch.description ?? before.description,
      feedProjectId: feed?.id ?? null,
      researchProjectId: research?.id ?? null,
      subCategory: patch.subCategory !== undefined ? patch.subCategory : before.subCategory,
      preferredSites: patch.preferredSites ?? before.preferredSites,
      scan,
      status,
    };
    if (feed && after.feedProjectId !== before.feedProjectId) {
      // A moved interest gets a new schedule; its template must be valid for the new project.
      await checkTemplate(tx, feed, 'feed', interestCardTemplate(after));
    }
    const sync = await syncSchedule(tx, ctx, user, before, after);
    after.scheduleId = sync.scheduleId;
    const events: AppendInput[] = [];
    const sub =
      (research ?? feed) ? subCategoryEvent((research ?? feed) as Row, after.subCategory, user) : null;
    if (sub) events.push(sub);
    events.push({
      streamId: streamId.interest(id),
      event: { type: 'InterestUpdated', payload: after },
      actor: userActor(user.id),
      scope: projectScope(after.orgId, (feed ?? research)?.id as string),
    });
    events.push(...sync.events);
    // A renamed interest re-renders its heading in taste.md; a moved one leaves its old project's rules behind.
    if (after.name !== before.name || after.feedProjectId !== before.feedProjectId) {
      const reseed = await reseedEvent(
        tx,
        user,
        before.feedProjectId,
        id,
        after.feedProjectId !== before.feedProjectId,
      );
      if (reseed) events.push(reseed);
    }
    await ctx.store.append(events, { tx });
  });
}

export async function deleteInterest(
  ctx: Ctx,
  user: User,
  id: string,
  opts: { keepSchedule: boolean },
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const row = await lockInterest(tx, user, id);
    const projectId = (row.feed_project_id ?? row.research_project_id) as string;
    const scope = projectScope(row.org_id, projectId);
    const events: AppendInput[] = [
      {
        streamId: streamId.interest(id),
        event: { type: 'InterestDeleted', payload: { interestId: id, keepSchedule: opts.keepSchedule } },
        actor: userActor(user.id),
        scope,
      },
    ];
    const reseed = await reseedEvent(tx, user, row.feed_project_id, id, true);
    if (reseed) events.push(reseed);
    if (row.schedule_id)
      events.push(
        opts.keepSchedule
          ? {
              streamId: streamId.schedule(row.schedule_id),
              event: { type: 'ScheduleLinked', payload: { scheduleId: row.schedule_id, interestId: null } },
              actor: userActor(user.id),
              scope,
            }
          : {
              streamId: streamId.schedule(row.schedule_id),
              event: { type: 'ScheduleDeleted', payload: { scheduleId: row.schedule_id } },
              actor: userActor(user.id),
              scope,
            },
      );
    await ctx.store.append(events, { tx });
  });
}

/** An unused name for an adopted interest: `name`, `name (2)`, `name (3)` ... */
async function uniqueName(db: Queryable, orgId: string, base: string): Promise<string> {
  const clean = base.trim().slice(0, 110) || 'Interest';
  let candidate = clean;
  for (let n = 2; n < 200; n++) {
    const taken = await one(db, 'SELECT 1 FROM interests WHERE org_id=$1 AND lower(name)=lower($2)', [
      orgId,
      candidate,
    ]);
    if (!taken) return candidate;
    candidate = `${clean} (${n})`;
  }
  return `${clean} (${randomUUID().slice(0, 4)})`;
}

export interface AdoptResult {
  scheduleId: string;
  interestId?: string;
  error?: string;
}

/**
 * Adopts existing feed schedules: one interest per schedule (`InterestCreated{adoptedFrom}` + `ScheduleLinked`), without
 * rewriting the card template. One append per schedule so one bad schedule does not block the rest.
 */
export async function adoptSchedules(ctx: Ctx, user: User, scheduleIds: string[]): Promise<AdoptResult[]> {
  const results: AdoptResult[] = [];
  for (const scheduleId of scheduleIds) {
    try {
      const interestId = await withAppendTx(ctx.pool, async (tx) => {
        const s = await one(tx, 'SELECT * FROM schedules WHERE id=$1 FOR UPDATE', [scheduleId]);
        if (!s) throw notFound('schedule not found');
        const project = await one(
          tx,
          `SELECT p.* FROM projects p JOIN project_members pm
             ON pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active' WHERE p.id = $2`,
          [user.id, s.project_id],
        );
        if (!project) throw notFound('schedule not found');
        if (s.kind !== 'feed') throw badRequest('not_a_feed_schedule', 'only feed schedules can be adopted');
        if (s.interest_id) throw conflict('already_linked', 'this schedule already belongs to an interest');
        if (project.status !== 'active') throw conflict('project_archived', 'project is archived');
        const template = s.card_template as CardTemplate;
        const fields = (template.fields ?? {}) as Record<string, unknown>;
        const topic = typeof fields.topic === 'string' && fields.topic.trim() ? fields.topic : undefined;
        const name = await uniqueName(tx, project.org_id, topic ?? s.name);
        const sites = Array.isArray(fields.preferredSites)
          ? (fields.preferredSites as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        const windowHours =
          typeof fields.windowHours === 'number' && fields.windowHours >= 1
            ? Math.min(720, Math.floor(fields.windowHours))
            : 24;
        const id = randomUUID();
        const body: InterestBody = {
          interestId: id,
          orgId: project.org_id,
          creatorRank: ((await rankInOrg(tx, user.id, project.org_id)) || 1) as 1 | 2 | 3 | 4,
          name,
          description: typeof fields.description === 'string' ? fields.description : '',
          feedProjectId: project.id,
          researchProjectId: null,
          subCategory: null,
          preferredSites: sites,
          scan: {
            cron: s.cron,
            timezone: s.timezone,
            windowHours,
            maxItems: Math.min(100, feedMaxItems(fields)),
            manual: false,
          },
          status: s.enabled ? 'active' : 'paused',
          scheduleId: s.id,
          adoptedFrom: s.id,
        };
        const scope = projectScope(project.org_id, project.id);
        await ctx.store.append(
          [
            {
              streamId: streamId.interest(id),
              event: { type: 'InterestCreated', payload: body },
              actor: userActor(user.id),
              scope,
            },
            {
              streamId: streamId.schedule(s.id),
              event: { type: 'ScheduleLinked', payload: { scheduleId: s.id, interestId: id } },
              actor: userActor(user.id),
              scope,
            },
          ],
          { tx },
        );
        return id;
      });
      results.push({ scheduleId, interestId });
    } catch (err) {
      results.push({ scheduleId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

// ------------------------------------------------------------------ explicit taste rules

export const sameRule = (a: TasteSeedLine, b: TasteSeedLine): boolean =>
  a.interestId === b.interestId && a.text.trim().toLowerCase() === b.text.trim().toLowerCase();

function dedupe(rules: TasteSeedLine[]): TasteSeedLine[] {
  const out: TasteSeedLine[] = [];
  for (const r of rules) {
    const text = r.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = { text, interestId: r.interestId };
    if (!out.some((o) => sameRule(o, line))) out.push(line);
  }
  return out;
}

async function loadFeedProject(tx: Queryable, user: User, projectId: string): Promise<Row> {
  const p = await loadProjectFor(tx, user, projectId, 'feed');
  return p;
}

async function appendTasteSeed(
  ctx: Ctx,
  tx: Tx,
  user: User,
  project: Row,
  rules: TasteSeedLine[],
  version: number,
): Promise<void> {
  await ctx.store.append(
    [
      {
        streamId: streamId.project(project.id),
        event: { type: 'TasteSeedSet', payload: { projectId: project.id, version, rules } },
        actor: userActor(user.id),
        scope: projectScope(project.org_id, project.id),
      },
    ],
    { tx },
  );
}

async function currentSeed(
  tx: Queryable,
  projectId: string,
): Promise<{ version: number; rules: TasteSeedLine[] }> {
  const r = await one(tx, 'SELECT version, rules FROM taste_seeds WHERE project_id=$1 FOR UPDATE', [
    projectId,
  ]);
  return { version: r?.version ?? 0, rules: (r?.rules as TasteSeedLine[] | undefined) ?? [] };
}

/**
 * A `TasteSeedSet` that re-renders the managed section after the interest changed (renamed: the heading; deleted: its
 * rules go). Null when the interest has no rules in the project's seed.
 */
async function reseedEvent(
  tx: Tx,
  user: User,
  feedProjectId: string | null,
  interestId: string,
  drop: boolean,
): Promise<AppendInput | null> {
  if (!feedProjectId) return null;
  const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [feedProjectId]);
  const cur = await currentSeed(tx, feedProjectId);
  if (!project || !cur.rules.some((r) => r.interestId === interestId)) return null;
  const rules = drop ? cur.rules.filter((r) => r.interestId !== interestId) : cur.rules;
  return {
    streamId: streamId.project(project.id),
    event: {
      type: 'TasteSeedSet',
      payload: { projectId: project.id, version: cur.version + 1, rules },
    },
    actor: userActor(user.id),
    scope: projectScope(project.org_id, project.id),
  };
}

/** Replaces the project's explicit rules (project-wide and interest-tagged). */
export async function setTasteSeed(
  ctx: Ctx,
  user: User,
  projectId: string,
  rules: TasteSeedLine[],
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const project = await loadFeedProject(tx, user, projectId);
    const ids = [...new Set(rules.map((r) => r.interestId).filter((x): x is string => !!x))];
    if (ids.length) {
      const known = await rows<{ id: string }>(
        tx,
        'SELECT id FROM interests WHERE feed_project_id=$1 AND id = ANY($2::uuid[])',
        [projectId, ids],
      );
      if (known.length !== ids.length)
        throw badRequest('unknown_interest', 'a rule is tagged with an interest of another project');
    }
    const cur = await currentSeed(tx, projectId);
    // The project's own rules follow the project; the rules of an interest follow the interest (its edit rule).
    const key = (r: TasteSeedLine) => `${r.interestId ?? ''}|${r.text}`;
    const before = new Set(cur.rules.map(key));
    const after = new Set(rules.map(key));
    const changed = new Set(
      [...cur.rules, ...rules]
        .filter((r) => r.interestId && before.has(key(r)) !== after.has(key(r)))
        .map((r) => r.interestId as string),
    );
    for (const interestId of changed) {
      const i = await one(tx, 'SELECT * FROM interests WHERE id=$1', [interestId]);
      if (i) await assertCanEditInterest(tx, user.id, i);
    }
    await appendTasteSeed(ctx, tx, user, project, dedupe(rules), cur.version + 1);
  });
}

/** Replaces only the rules tagged with this interest, so two open drawers do not overwrite each other. */
export async function setInterestTaste(
  ctx: Ctx,
  user: User,
  interestId: string,
  texts: string[],
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const i = await lockInterest(tx, user, interestId);
    if (!i.feed_project_id) throw conflict('no_feed_project', 'this interest has no feed project');
    const project = await loadFeedProject(tx, user, i.feed_project_id);
    const cur = await currentSeed(tx, project.id);
    const kept = cur.rules.filter((r) => r.interestId !== interestId);
    const mine = texts.map((text) => ({ text, interestId }));
    await appendTasteSeed(ctx, tx, user, project, dedupe([...kept, ...mine]), cur.version + 1);
  });
}

/** Re-sends the current rules to the vault by appending the same rules at the next version. */
export async function resyncTasteSeed(ctx: Ctx, user: User, projectId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const project = await loadFeedProject(tx, user, projectId);
    const cur = await currentSeed(tx, projectId);
    await appendTasteSeed(ctx, tx, user, project, cur.rules, cur.version + 1);
  });
}
