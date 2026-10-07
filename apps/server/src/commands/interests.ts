import { randomUUID } from 'node:crypto';
import {
  type CreateInterestRequest,
  canEditInterest,
  type DeliverySpec,
  defaultWindowHours,
  effectiveCreatorRank,
  IMMEDIATE_DELIVERY,
  type InterestAgents,
  type InterestBody,
  interestBackingKey,
  interestSlug,
  interestVaultDir,
  isOrgManager,
  type OrgRole,
  type PatchInterestRequest,
  type ScanSpec,
  streamId,
} from '@aom/shared';
import { orgRoleOf, rankInOrg } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { projectRole } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { projectScope, userActor } from './common.ts';
import { archiveProject, restoreProject } from './projects.ts';
import { assertCronAndZone, nextFireAfter } from './schedules.ts';
import { removeMemberIn } from './sharing.ts';

/**
 * Interest commands (docs/design/restructure.md section 5.2). An interest is org-level and backed by a hidden project;
 * every command appends the events it needs in one transaction. Who may change an interest (owner decision, the role
 * rule): its creator, or someone whose role in the organization is at the creator's level or higher
 * (Owner > Admin > Member > Guest), the stored rank standing in once the creator has left. Seeing it needs an active
 * membership of the backing project.
 */

type User = AuthSession['user'];

const DEFAULT_CRON = '0 7 * * *';
const AGENT_ROLES = ['scout', 'curator', 'researcher', 'checker'] as const;

/** The row as the `InterestBody` snapshot the events carry. */
export function interestBody(r: Row): InterestBody {
  return {
    interestId: r.id,
    orgId: r.org_id,
    name: r.name,
    description: r.description ?? '',
    subCategory: r.sub_category ?? null,
    preferredSites: r.preferred_sites ?? [],
    scan: (r.scan as ScanSpec | null) ?? null,
    status: r.status,
    ...(r.created_by_rank ? { creatorRank: r.created_by_rank } : {}),
    ...(r.project_id ? { projectId: r.project_id } : {}),
    ...(r.slug ? { slug: r.slug } : {}),
    ...(r.domain ? { domain: r.domain } : {}),
    kinds: r.kinds ?? ['article', 'video', 'podcast'],
    agents: (r.agents as InterestAgents) ?? {},
    delivery: (r.delivery as DeliverySpec) ?? IMMEDIATE_DELIVERY,
    nextScanAt: r.next_scan_at ? new Date(r.next_scan_at).toISOString() : null,
    nextDeliveryAt: r.next_delivery_at ? new Date(r.next_delivery_at).toISOString() : null,
  };
}

function resolveScan(req: Partial<ScanSpec> | undefined, fallback?: ScanSpec | null): ScanSpec {
  const cron = (req?.cron ?? fallback?.cron ?? DEFAULT_CRON).trim();
  const timezone = req?.timezone ?? fallback?.timezone ?? 'UTC';
  assertCronAndZone(cron, timezone);
  // A window that was the cadence's default follows the cadence when only the cron changes.
  const followed =
    fallback && cron !== fallback.cron.trim() && fallback.windowHours === defaultWindowHours(fallback.cron)
      ? defaultWindowHours(cron)
      : fallback?.windowHours;
  const keepWindow = fallback && cron === fallback.cron.trim() ? fallback.windowHours : undefined;
  return {
    cron,
    timezone,
    windowHours: req?.windowHours ?? keepWindow ?? followed ?? defaultWindowHours(cron),
    maxItems: req?.maxItems ?? fallback?.maxItems ?? 10,
    manual: req?.manual ?? fallback?.manual ?? false,
  };
}

function resolveDelivery(
  req: Partial<DeliverySpec> | undefined,
  fallback?: DeliverySpec | null,
): DeliverySpec {
  const base = fallback ?? IMMEDIATE_DELIVERY;
  const d: DeliverySpec = {
    mode: req?.mode ?? base.mode,
    cron: (req?.cron ?? base.cron).trim(),
    timezone: req?.timezone ?? base.timezone,
  };
  if (d.mode === 'scheduled') assertCronAndZone(d.cron, d.timezone);
  return d;
}

/** The next run and delivery times of an interest that is active (null otherwise, or when it only runs by hand). */
export function nextTimes(
  b: Pick<InterestBody, 'status' | 'scan'> & { delivery?: DeliverySpec | undefined },
  now: Date,
): { nextScanAt: string | null; nextDeliveryAt: string | null } {
  const active = b.status === 'active';
  const scan = b.scan && !b.scan.manual && active ? nextFireAfter(b.scan.cron, b.scan.timezone, now) : null;
  const d = b.delivery;
  const del = d && d.mode === 'scheduled' && active ? nextFireAfter(d.cron, d.timezone, now) : null;
  return { nextScanAt: scan?.toISOString() ?? null, nextDeliveryAt: del?.toISOString() ?? null };
}

async function assertNameFree(db: Queryable, orgId: string, name: string, exceptId?: string): Promise<void> {
  const taken = await one(
    db,
    'SELECT id FROM interests WHERE org_id=$1 AND lower(name)=lower($2) AND ($3::uuid IS NULL OR id <> $3)',
    [orgId, name, exceptId ?? null],
  );
  if (taken) throw conflict('interest_name_taken', `an interest named "${name}" already exists`);
}

/** The agents named must belong to the interest's organization and have the role they are named for. */
async function assertAgents(
  db: Queryable,
  orgId: string,
  agents: Record<string, string | null | undefined>,
): Promise<void> {
  for (const role of AGENT_ROLES) {
    const id = agents[role];
    if (!id) continue;
    const a = await one(db, `SELECT role_key, org_id, status FROM agents WHERE id=$1 AND NOT is_devops`, [
      id,
    ]);
    if (!a || a.org_id !== orgId || a.status === 'retired')
      throw badRequest('agent_not_eligible', `the ${role} must be an active agent of this organization`);
    if (a.role_key !== role)
      throw badRequest('agent_not_eligible', `the agent named as ${role} does not have the ${role} role`);
  }
}

export interface InterestOrg {
  id: string;
  role: OrgRole | null;
}

export async function createInterest(
  ctx: Ctx,
  user: User,
  org: InterestOrg,
  req: CreateInterestRequest,
): Promise<string> {
  const interestId = randomUUID();
  const projectId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    const rank = await rankInOrg(tx, user.id, org.id);
    if (rank < 1) throw forbidden('you have no access to this organization');
    await assertNameFree(tx, org.id, req.name);
    const scan = resolveScan(req.scan);
    const delivery = resolveDelivery(req.delivery);
    await assertAgents(tx, org.id, req.agents ?? {});
    const slug = interestSlug(
      req.name,
      (
        await rows<{ slug: string }>(tx, 'SELECT slug FROM interests WHERE org_id=$1 AND slug IS NOT NULL', [
          org.id,
        ])
      ).map((r) => r.slug),
    );
    const key = interestBackingKey(
      slug,
      (await rows<{ key: string }>(tx, 'SELECT key FROM projects WHERE org_id=$1', [org.id])).map(
        (r) => r.key,
      ),
    );
    const now = ctx.clock.now();
    const body: InterestBody = {
      interestId,
      orgId: org.id,
      creatorRank: rank as 1 | 2 | 3 | 4,
      name: req.name,
      description: req.description,
      subCategory: req.subCategory ?? null,
      preferredSites: req.preferredSites,
      scan,
      status: req.status,
      projectId,
      slug,
      domain: req.domain,
      kinds: req.kinds,
      agents: Object.fromEntries(Object.entries(req.agents ?? {}).filter(([, v]) => v)) as InterestAgents,
      delivery,
      ...nextTimes({ status: req.status, scan, delivery }, now),
    };
    const scope = projectScope(org.id, projectId);
    const actor = userActor(user.id);
    const manager = isOrgManager({ orgRole: org.role });
    const events: AppendInput[] = [
      {
        streamId: streamId.project(projectId),
        event: {
          type: 'ProjectCreated',
          payload: {
            projectId,
            orgId: org.id,
            createdByUserId: user.id,
            key,
            name: req.name,
            domain: req.domain,
            workflowKey: 'feed',
            priorityTier: 2,
            branchPrefix: 'aom/',
            workingBranch: 'main',
            subCategories: [],
            vaultFolder: null,
            kind: 'interest',
            vaultDir: interestVaultDir(slug),
            // The Owner and Admins see every interest through their organization grant; a Member or guest is its member.
            ...(manager ? {} : { members: [{ userId: user.id, role: 'owner' as const }] }),
          },
        },
        actor,
        scope,
      },
      {
        streamId: streamId.interest(interestId),
        event: { type: 'InterestCreated', payload: body },
        actor,
        scope,
      },
    ];
    if (req.tasteRules.length > 0)
      events.push({
        streamId: streamId.interest(interestId),
        event: {
          type: 'InterestTasteSet',
          payload: { interestId, version: 1, rules: dedupeRules(req.tasteRules) },
        },
        actor,
        scope,
      });
    await ctx.store.append(events, { tx });
  });
  return interestId;
}

/**
 * Edit rule of an interest (docs/design/organizations.md section 4.3): the creator, or someone of at least the
 * creator's rank in the interest's organization. The creator's current rank counts while they still have a relationship
 * with the organization; the rank stored at creation is the fallback once they left.
 */
export async function assertCanEditInterest(tx: Queryable, userId: string, i: Row): Promise<void> {
  const actorRank = await rankInOrg(tx, userId, i.org_id);
  const current = i.created_by ? await rankInOrg(tx, i.created_by, i.org_id) : 0;
  const creatorRank = effectiveCreatorRank(current, i.created_by_rank ?? undefined);
  if (
    !canEditInterest({ userId, rank: actorRank }, { userId: i.created_by ?? null, rank: creatorRank }, true)
  )
    throw forbidden(
      'only its creator, or someone of the same or a higher role in the organization, can change this interest',
    );
}

/** The interest row, locked, when the user may see it (404 otherwise) and may change it (403 otherwise). */
export async function lockInterest(
  tx: Tx,
  user: User,
  id: string,
  opts: { allowArchived?: boolean } = {},
): Promise<Row> {
  const i = await one(tx, 'SELECT * FROM interests WHERE id=$1 FOR UPDATE', [id]);
  if (!i || !i.project_id || !(await projectRole(tx, user.id, i.project_id)))
    throw notFound('interest not found');
  await assertCanEditInterest(tx, user.id, i);
  if (i.archived_at && !opts.allowArchived)
    throw conflict('interest_archived', 'this interest is archived: restore it first');
  return i;
}

function dedupeRules(rules: string[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    const text = r.replace(/\s+/g, ' ').trim();
    if (text && !out.some((o) => o.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out;
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
    const name = patch.name ?? before.name;
    if (name.toLowerCase() !== before.name.toLowerCase()) await assertNameFree(tx, before.orgId, name, id);
    if (patch.domain && patch.domain !== before.domain) {
      const ran = await one(tx, 'SELECT 1 FROM interest_runs WHERE interest_id=$1 LIMIT 1', [id]);
      if (ran)
        throw badRequest(
          'domain_locked',
          'the vault (work or personal) is fixed once the interest has run: create a new interest instead',
        );
    }
    const scan = patch.scan ? resolveScan(patch.scan, before.scan) : before.scan;
    const delivery = patch.delivery ? resolveDelivery(patch.delivery, before.delivery) : before.delivery;
    const agents: Record<string, string | undefined> = { ...(before.agents ?? {}) };
    if (patch.agents) {
      for (const role of AGENT_ROLES) {
        const v = patch.agents[role];
        if (v === null) delete agents[role];
        else if (v) agents[role] = v;
      }
      await assertAgents(tx, before.orgId, agents);
    }
    const status = patch.status ?? before.status;
    const now = ctx.clock.now();
    const cadenceChanged =
      status !== before.status ||
      JSON.stringify(scan) !== JSON.stringify(before.scan) ||
      JSON.stringify(delivery) !== JSON.stringify(before.delivery);
    const after: InterestBody = {
      ...before,
      name,
      description: patch.description ?? before.description,
      subCategory: patch.subCategory !== undefined ? patch.subCategory : before.subCategory,
      preferredSites: patch.preferredSites ?? before.preferredSites,
      kinds: patch.kinds ?? before.kinds,
      domain: patch.domain ?? before.domain,
      scan,
      delivery,
      agents: agents as InterestAgents,
      status,
      ...(cadenceChanged || !row.next_scan_at
        ? nextTimes({ status, scan, delivery }, now)
        : { nextScanAt: before.nextScanAt ?? null, nextDeliveryAt: before.nextDeliveryAt ?? null }),
    };
    // Pausing and resuming only move the schedule: the next run and delivery are recomputed from now.
    const scope = projectScope(after.orgId, row.project_id);
    const events: AppendInput[] = [
      {
        streamId: streamId.interest(id),
        event: { type: 'InterestUpdated', payload: after },
        actor: userActor(user.id),
        scope,
      },
    ];
    if (after.name !== before.name || after.domain !== before.domain)
      events.push({
        streamId: streamId.project(row.project_id),
        event: {
          type: 'ProjectUpdated',
          payload: {
            projectId: row.project_id,
            changes: { name: after.name, ...(after.domain ? { domain: after.domain } : {}) },
          },
        },
        actor: userActor(user.id),
        scope,
      });
    await ctx.store.append(events, { tx });
  });
}

export async function archiveInterest(ctx: Ctx, user: User, id: string): Promise<void> {
  const row = await withAppendTx(ctx.pool, (tx) => lockInterest(tx, user, id));
  await archiveProject(ctx, user, row.project_id, { interestId: id });
}

export async function restoreInterest(ctx: Ctx, user: User, id: string): Promise<void> {
  const row = await withAppendTx(ctx.pool, (tx) => lockInterest(tx, user, id, { allowArchived: true }));
  if (!row.archived_at) throw conflict('not_archived', 'this interest is not archived');
  await restoreProject(ctx, user, row.project_id, { interestId: id });
  // The restored interest picks up its cadence again from now.
  await withAppendTx(ctx.pool, async (tx) => {
    const r = await lockInterest(tx, user, id, { allowArchived: true });
    const b = interestBody(r);
    await ctx.store.append(
      [
        {
          streamId: streamId.interest(id),
          event: { type: 'InterestUpdated', payload: { ...b, ...nextTimes(b, ctx.clock.now()) } },
          actor: userActor(user.id),
          scope: projectScope(b.orgId, r.project_id),
        },
      ],
      { tx },
    );
  });
}

/** Permanent delete of an archived interest: the caller types its slug. Its cards, items and seen-list go with the project. */
export async function deleteInterest(ctx: Ctx, user: User, id: string, confirmSlug: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const row = await lockInterest(tx, user, id, { allowArchived: true });
    if (!row.archived_at)
      throw conflict('not_archived', 'archive the interest first: only an archived interest can be deleted');
    if (confirmSlug !== row.slug)
      throw badRequest('slug_mismatch', 'type the interest folder name to confirm');
    const project = await one(tx, 'SELECT key, name FROM projects WHERE id=$1', [row.project_id]);
    const scope = projectScope(row.org_id, row.project_id);
    await ctx.store.append(
      [
        {
          streamId: streamId.interest(id),
          event: { type: 'InterestDeleted', payload: { interestId: id, keepSchedule: false } },
          actor: userActor(user.id),
          scope,
        },
        {
          streamId: streamId.project(row.project_id),
          event: {
            type: 'ProjectDeleted',
            payload: {
              projectId: row.project_id,
              key: project?.key ?? '',
              name: project?.name ?? row.name,
              deletedBy: user.id,
            },
          },
          actor: userActor(user.id),
          scope,
        },
      ],
      { tx },
    );
  });
}

// ------------------------------------------------------------------ taste rules built into the interest

/** Replaces the interest's taste rules (the same edit rule as the interest itself). */
export async function setInterestTaste(ctx: Ctx, user: User, id: string, rules: string[]): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const i = await lockInterest(tx, user, id);
    await ctx.store.append(
      [
        {
          streamId: streamId.interest(id),
          event: {
            type: 'InterestTasteSet',
            payload: { interestId: id, version: Number(i.taste_version ?? 0) + 1, rules: dedupeRules(rules) },
          },
          actor: userActor(user.id),
          scope: projectScope(i.org_id, i.project_id),
        },
      ],
      { tx },
    );
  });
}

/** Re-sends the current rules to the vault by setting the same rules at the next version ("Resync taste.md"). */
export async function resyncInterestTaste(ctx: Ctx, user: User, id: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const i = await lockInterest(tx, user, id);
    await ctx.store.append(
      [
        {
          streamId: streamId.interest(id),
          event: {
            type: 'InterestTasteSet',
            payload: {
              interestId: id,
              version: Number(i.taste_version ?? 0) + 1,
              rules: (i.taste_rules as string[]) ?? [],
            },
          },
          actor: userActor(user.id),
          scope: projectScope(i.org_id, i.project_id),
        },
      ],
      { tx },
    );
  });
}

// ------------------------------------------------------------------ sharing (Owner and Admins)

async function shareable(tx: Tx, user: User, id: string): Promise<Row> {
  const i = await one(tx, 'SELECT * FROM interests WHERE id=$1 FOR UPDATE', [id]);
  if (!i || !i.project_id || !(await projectRole(tx, user.id, i.project_id)))
    throw notFound('interest not found');
  const role = await orgRoleOf(tx, user.id, i.org_id);
  if (!isOrgManager({ orgRole: role }))
    throw forbidden('only the Owner and Admins of the organization can share an interest');
  return i;
}

/** Gives an active member of the organization access to the interest (and so to the digests and its taste). */
export async function shareInterest(ctx: Ctx, user: User, id: string, userId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const i = await shareable(tx, user, id);
    const m = await orgRoleOf(tx, userId, i.org_id);
    if (!m) throw badRequest('not_a_member', 'only members of the organization can be added to an interest');
    const have = await one(
      tx,
      `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`,
      [i.project_id, userId],
    );
    if (have) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(i.project_id),
          event: {
            type: 'ProjectMemberAdded',
            payload: { projectId: i.project_id, userId, addedBy: user.id },
          },
          actor: userActor(user.id),
          scope: projectScope(i.org_id, i.project_id),
        },
      ],
      { tx },
    );
  });
}

export async function unshareInterest(ctx: Ctx, user: User, id: string, userId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const i = await shareable(tx, user, id);
    const p = await one(tx, 'SELECT * FROM projects WHERE id=$1', [i.project_id]);
    const row = await one(
      tx,
      `SELECT org_grant, direct FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`,
      [i.project_id, userId],
    );
    if (!row || !p) throw notFound('member not found');
    if (row.org_grant && !row.direct) throw badRequest('org_grant', 'Owners and Admins see every interest');
    await removeMemberIn(ctx, tx, user.id, p, userId);
  });
}
