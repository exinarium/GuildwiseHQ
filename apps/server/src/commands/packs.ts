import { randomUUID } from 'node:crypto';
import {
  type AddPackRequest,
  diffPackSnapshots,
  isOrgManager,
  PACK_PRESETS,
  PACKS_CAPABILITY,
  type PackDesired,
  type PackDetailDto,
  type PackDto,
  type PackSnapshot,
  type PacksReport,
  type PacksResponse,
  type ProjectCapabilitiesReport,
  packSnapshotContentHash,
  type RunnerToServerOf,
  streamId,
} from '@aom/shared';
import type { Who } from '../auth/org-context.ts';
import { orgRoleOf } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { orgScope, runnerActor, userActor } from './common.ts';
import { deliver } from './workstation-setup.ts';

/**
 * Capability packs (docs/ARCHITECTURE.md section 38.4). The owner adds a git URL and ref; a workstation fetches it, the first
 * report pins the commit; nothing is usable until the owner approves it at that commit and content hash; a newer commit is only
 * ever offered with a diff, and the pin moves when the owner accepts it. The files never reach the server.
 */
const requireManager = (who: Who): void => {
  if (!isOrgManager({ orgRole: who.role })) throw forbidden('only owners and admins manage capability packs');
};

const MAX_PACKS = 30;

/** True when any workstation found the pack's files changed from the approved content. */
const INTEGRITY_SQL = `EXISTS (SELECT 1 FROM pack_workstation_state s WHERE s.pack_id = p.id AND s.integrity_failed)`;

function dto(r: Row): PackDto {
  const preset = PACK_PRESETS.find((p) => p.id === r.preset);
  const snap = r.snapshot as PackSnapshot | null;
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    ref: r.ref,
    adapter: r.adapter,
    scope: r.scope,
    projectId: r.project_id ?? null,
    preset: r.preset ?? null,
    status: r.status,
    error: r.error ?? null,
    pinnedSha: r.pinned_sha ?? null,
    contentHash: r.content_hash ?? null,
    trusted: !!r.trusted && r.trusted_sha === r.pinned_sha && r.trusted_hash === r.content_hash,
    trustedSha: r.trusted_sha ?? null,
    scriptsEnabled: !!r.scripts_enabled,
    hasScripts: !!r.has_scripts,
    license: r.license ?? null,
    integrityFailed: !!r.integrity_failed,
    itemCount: snap?.items.length ?? 0,
    workstationIds: (r.workstation_ids ?? []) as string[],
    update: r.update_snapshot
      ? {
          sha: (r.update_snapshot as PackSnapshot).sha,
          ref: (r.update_snapshot as PackSnapshot).ref,
          diff: r.update_diff,
          foundAt: iso(r.update_found_at) as string,
        }
      : null,
    lastCheckedAt: iso(r.last_checked_at),
    addedAt: iso(r.added_at) as string,
    attribution: preset?.attribution ?? null,
  };
}

async function load(db: Queryable, who: Who, id: string, lock = false): Promise<Row> {
  const r = await one(
    db,
    `SELECT p.*, ${INTEGRITY_SQL} AS integrity_failed FROM packs p
      WHERE p.id=$1 AND p.org_id=$2 AND p.removed_at IS NULL ${lock ? 'FOR UPDATE OF p' : ''}`,
    [id, who.orgId],
  );
  if (!r) throw notFound('pack not found');
  return r;
}

/** Workstations of the organization's members that announce `packs:1`: the ones an admin may choose from. */
async function packWorkstations(
  db: Queryable,
  orgId: string,
): Promise<Array<{ id: string; name: string; user_id: string }>> {
  return rows(
    db,
    `SELECT w.id, w.name, w.user_id FROM workstations w
       JOIN org_members om ON om.user_id = w.user_id AND om.org_id = $1 AND om.status = 'active'
       JOIN workstation_capabilities wc ON wc.workstation_id = w.id
      WHERE w.status = 'active' AND $2 = ANY(wc.capabilities)
      ORDER BY w.name, w.id`,
    [orgId, PACKS_CAPABILITY],
  );
}

/**
 * Whether a pack may be on, and may be reported by, this workstation: it is active, its owner is an active member of the
 * pack's organization, and it is one the adding admin chose (no choice: any workstation of the admin who added the pack).
 */
const HOLDS_PACK_SQL = `w.status = 'active'
  AND EXISTS (SELECT 1 FROM org_members om WHERE om.user_id = w.user_id AND om.org_id = p.org_id AND om.status = 'active')
  AND (w.id = ANY(p.workstation_ids) OR (cardinality(p.workstation_ids) = 0 AND w.user_id = p.added_by))`;

export async function workstationHoldsPack(
  db: Queryable,
  packId: string,
  workstationId: string,
): Promise<boolean> {
  return !!(await one(
    db,
    `SELECT 1 FROM packs p JOIN workstations w ON w.id = $2
      WHERE p.id = $1 AND p.removed_at IS NULL AND ${HOLDS_PACK_SQL}`,
    [packId, workstationId],
  ));
}

/** Every pack this workstation is meant to hold, as `packs.sync` wants them. Packs of other workstations are never sent. */
export async function desiredPacksFor(db: Queryable, workstationId: string): Promise<PackDesired[]> {
  const r = await rows(
    db,
    `SELECT p.* FROM packs p JOIN workstations w ON w.id = $1
      WHERE p.removed_at IS NULL AND ${HOLDS_PACK_SQL}
      ORDER BY p.added_at`,
    [workstationId],
  );
  return r.map((p) => ({
    packId: p.id,
    orgId: p.org_id,
    name: p.name,
    url: p.url,
    ref: p.ref,
    adapter: p.adapter,
    scope: p.scope,
    projectId: p.project_id ?? null,
    pinnedSha: p.pinned_sha ?? null,
    trusted:
      p.trusted && p.trusted_sha && p.trusted_hash
        ? { sha: p.trusted_sha, contentHash: p.trusted_hash }
        : null,
    scriptsEnabled: !!p.scripts_enabled,
  }));
}

/** Replaces any waiting `packs.sync` for the workstation by the current full list. */
export async function queuePacksSync(db: Queryable, workstationId: string): Promise<void> {
  await db.query(
    `UPDATE runner_commands SET status='failed', last_error='superseded'
      WHERE workstation_id=$1 AND type='packs.sync' AND status IN ('pending','sent')`,
    [workstationId],
  );
  await enqueueRunnerCommand(db, workstationId, 'packs.sync', {
    packs: await desiredPacksFor(db, workstationId),
    blocked: await blockedProjectCapabilities(db, workstationId),
  });
}

/** The project-repository capabilities the owner blocked, in the organizations this workstation's owner belongs to. */
export async function blockedProjectCapabilities(
  db: Queryable,
  workstationId: string,
): Promise<Array<{ projectId: string; kind: 'skill' | 'persona' | 'playbook'; key: string }>> {
  const r = await rows(
    db,
    `SELECT cr.project_id, cr.kind, cr.key FROM capability_reviews cr
       JOIN workstations w ON w.id = $1
       JOIN org_members om ON om.user_id = w.user_id AND om.org_id = cr.org_id AND om.status = 'active'
      WHERE cr.status = 'blocked' ORDER BY cr.project_id, cr.kind, cr.key LIMIT 1000`,
    [workstationId],
  );
  return r.map((x) => ({ projectId: x.project_id, kind: x.kind, key: x.key }));
}

export async function syncOrg(ctx: Ctx, orgId: string): Promise<void> {
  const ws = await packWorkstations(ctx.pool, orgId);
  for (const w of ws) await queuePacksSync(ctx.pool, w.id);
  deliver(
    ctx,
    ws.map((w) => w.id),
  );
}

const ev = (
  type: string,
  payload: Record<string, unknown>,
  orgId: string,
  packId: string,
  by?: string,
): AppendInput =>
  ({
    streamId: streamId.pack(packId),
    event: { type, payload },
    actor: by ? userActor(by) : { kind: 'system', id: null },
    scope: orgScope(orgId),
  }) as AppendInput;

// -------------------------------------------------------------------------------------------------- reads

export async function listPacks(ctx: Ctx, who: Who): Promise<PacksResponse> {
  requireManager(who);
  const r = await rows(
    ctx.pool,
    `SELECT p.*, ${INTEGRITY_SQL} AS integrity_failed FROM packs p
      WHERE p.org_id=$1 AND p.removed_at IS NULL ORDER BY p.added_at`,
    [who.orgId],
  );
  const ws = await packWorkstations(ctx.pool, who.orgId);
  return {
    packs: r.map(dto),
    // the caller's own: the default holders of a pack they add
    workstationsOnline: ws.filter((w) => w.user_id === who.userId && ctx.services.runners.isOnline(w.id))
      .length,
    workstations: ws.map((w) => ({
      id: w.id,
      name: w.name,
      mine: w.user_id === who.userId,
      online: ctx.services.runners.isOnline(w.id),
    })),
  };
}

export async function getPack(ctx: Ctx, who: Who, id: string): Promise<PackDetailDto> {
  requireManager(who);
  const r = await load(ctx.pool, who, id);
  return { ...dto(r), snapshot: r.snapshot ?? null, updateSnapshot: r.update_snapshot ?? null };
}

// -------------------------------------------------------------------------------------------------- owner actions

const slugOf = (url: string): string =>
  (
    url
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .filter(Boolean)
      .pop() ?? 'pack'
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'pack';

export async function addPack(ctx: Ctx, who: Who, req: AddPackRequest): Promise<PackDto> {
  requireManager(who);
  const preset = req.preset ? PACK_PRESETS.find((p) => p.id === req.preset) : undefined;
  if (req.preset && !preset) throw badRequest('unknown_preset', 'unknown preset');
  const name = req.name ?? preset?.name ?? slugOf(req.url);
  if (
    !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) ||
    ['skill', 'persona', 'playbook', 'builtin', 'org', 'project', 'pack'].includes(name)
  )
    throw badRequest('invalid_pack_name', 'choose another name for the pack');
  if (req.scope === 'project' && !req.projectId)
    throw badRequest('project_required', 'a project pack needs a project');
  const id = randomUUID();
  const chosen = [...new Set(req.workstationIds ?? [])];
  await withAppendTx(ctx.pool, async (tx) => {
    if (chosen.length) {
      const ok = await packWorkstations(tx, who.orgId);
      const known = new Map(ok.map((w) => [w.id, w]));
      if (chosen.some((c) => !known.has(c)))
        throw badRequest(
          'unknown_workstation',
          'choose workstations of this organization that can hold packs',
        );
      // only a workstation of the admin who adds the pack may pin it, so at least one of those must hold it
      if (!chosen.some((c) => known.get(c)?.user_id === who.userId))
        throw badRequest('own_workstation_required', 'include at least one of your own workstations');
    }
    if (req.scope === 'project') {
      const p = await one(tx, 'SELECT id FROM projects WHERE id=$1 AND org_id=$2', [
        req.projectId,
        who.orgId,
      ]);
      if (!p) throw notFound('project not found');
    }
    const n = await one(tx, 'SELECT count(*)::int AS n FROM packs WHERE org_id=$1 AND removed_at IS NULL', [
      who.orgId,
    ]);
    if ((n?.n ?? 0) >= MAX_PACKS) throw conflict('too_many_packs', `at most ${MAX_PACKS} packs`);
    const dup = await one(tx, 'SELECT 1 FROM packs WHERE org_id=$1 AND name=$2 AND removed_at IS NULL', [
      who.orgId,
      name,
    ]);
    if (dup) throw conflict('pack_name_taken', `a pack named "${name}" already exists: choose another name`);
    await ctx.store.append(
      [
        ev(
          'PackAdded',
          {
            packId: id,
            orgId: who.orgId,
            name,
            url: req.url,
            ref: req.ref,
            adapter: preset && req.adapter === 'auto' ? preset.adapter : req.adapter,
            scope: req.scope,
            projectId: req.scope === 'project' ? (req.projectId ?? null) : null,
            preset: preset?.id ?? null,
            addedBy: who.userId,
            workstationIds: chosen,
          },
          who.orgId,
          id,
          who.userId,
        ),
      ],
      { tx },
    );
  });
  await syncOrg(ctx, who.orgId);
  return dto(await load(ctx.pool, who, id));
}

export async function checkPack(ctx: Ctx, who: Who, id: string, ref?: string): Promise<{ queued: boolean }> {
  requireManager(who);
  const r = await load(ctx.pool, who, id);
  if (!r.pinned_sha) throw conflict('pack_pending', 'the pack has not been fetched yet');
  // only a workstation of the admin who added the pack reports updates (the same one that pinned it)
  const holders = await rows(
    ctx.pool,
    `SELECT w.id FROM packs p JOIN workstations w ON w.user_id = p.added_by
       JOIN workstation_capabilities wc ON wc.workstation_id = w.id
      WHERE p.id = $1 AND ${HOLDS_PACK_SQL} AND $2 = ANY(wc.capabilities) ORDER BY w.id`,
    [id, PACKS_CAPABILITY],
  );
  const first = holders.find((w) => ctx.services.runners.isOnline(w.id));
  if (!first)
    throw conflict('no_workstation', 'no workstation that can fetch packs is online: start your runner');
  await enqueueRunnerCommand(ctx.pool, first.id, 'pack.check', { packId: id, ...(ref ? { ref } : {}) });
  deliver(ctx, [first.id]);
  return { queued: true };
}

export async function acceptPackUpdate(ctx: Ctx, who: Who, id: string, sha: string): Promise<PackDto> {
  requireManager(who);
  await withAppendTx(ctx.pool, async (tx) => {
    const r = await load(tx, who, id, true);
    const up = r.update_snapshot as PackSnapshot | null;
    if (!up || up.sha !== sha)
      throw conflict('update_changed', 'the update on offer is not the one you reviewed: look at it again');
    const diff = (r.update_diff ?? {}) as { scriptsAdded?: string[]; scriptsChanged?: string[] };
    const trustedNow = !!r.trusted && r.trusted_sha === r.pinned_sha && r.trusted_hash === r.content_hash;
    await ctx.store.append(
      [
        ev(
          'PackUpdateAccepted',
          {
            packId: id,
            orgId: who.orgId,
            sha: up.sha,
            ref: up.ref,
            contentHash: up.contentHash,
            acceptedBy: who.userId,
            keepTrust: trustedNow,
            scriptsReset: (diff.scriptsAdded?.length ?? 0) + (diff.scriptsChanged?.length ?? 0) > 0,
          },
          who.orgId,
          id,
          who.userId,
        ),
      ],
      { tx },
    );
  });
  await syncOrg(ctx, who.orgId);
  return dto(await load(ctx.pool, who, id));
}

export async function trustPack(
  ctx: Ctx,
  who: Who,
  id: string,
  req: { sha: string; contentHash: string },
): Promise<PackDto> {
  requireManager(who);
  await withAppendTx(ctx.pool, async (tx) => {
    const r = await load(tx, who, id, true);
    if (!r.pinned_sha)
      throw conflict('pack_pending', 'the pack has not been fetched yet: there is nothing to approve');
    if (r.pinned_sha !== req.sha || r.content_hash !== req.contentHash)
      throw conflict('pack_changed', 'the pack changed since you reviewed it: review it again');
    await ctx.store.append(
      [
        ev(
          'PackTrusted',
          { packId: id, orgId: who.orgId, sha: req.sha, contentHash: req.contentHash, trustedBy: who.userId },
          who.orgId,
          id,
          who.userId,
        ),
      ],
      { tx },
    );
  });
  await syncOrg(ctx, who.orgId);
  return dto(await load(ctx.pool, who, id));
}

export async function revokePack(ctx: Ctx, who: Who, id: string): Promise<PackDto> {
  requireManager(who);
  await withAppendTx(ctx.pool, async (tx) => {
    await load(tx, who, id, true);
    await ctx.store.append(
      [
        ev(
          'PackTrustRevoked',
          { packId: id, orgId: who.orgId, revokedBy: who.userId },
          who.orgId,
          id,
          who.userId,
        ),
      ],
      { tx },
    );
  });
  await syncOrg(ctx, who.orgId);
  return dto(await load(ctx.pool, who, id));
}

export async function setPackScripts(ctx: Ctx, who: Who, id: string, enabled: boolean): Promise<PackDto> {
  requireManager(who);
  await withAppendTx(ctx.pool, async (tx) => {
    const r = await load(tx, who, id, true);
    const trustedNow = !!r.trusted && r.trusted_sha === r.pinned_sha && r.trusted_hash === r.content_hash;
    if (enabled && !trustedNow)
      throw conflict('pack_not_trusted', 'approve the pack before enabling its scripts');
    if (enabled && !r.has_scripts) throw conflict('no_scripts', 'this pack has no scripts');
    await ctx.store.append(
      [
        ev(
          'PackScriptsChanged',
          { packId: id, orgId: who.orgId, enabled, changedBy: who.userId },
          who.orgId,
          id,
          who.userId,
        ),
      ],
      { tx },
    );
  });
  await syncOrg(ctx, who.orgId);
  return dto(await load(ctx.pool, who, id));
}

export async function removePack(ctx: Ctx, who: Who, id: string): Promise<void> {
  requireManager(who);
  await withAppendTx(ctx.pool, async (tx) => {
    await load(tx, who, id, true);
    await ctx.store.append(
      [ev('PackRemoved', { packId: id, orgId: who.orgId, removedBy: who.userId }, who.orgId, id, who.userId)],
      { tx },
    );
  });
  await syncOrg(ctx, who.orgId);
}

// -------------------------------------------------------------------------------------------------- runner reports

/**
 * `packs.report` from a workstation. Only a workstation of a member of the pack's organization may report. The server decides
 * what a report means: the first `resolved` pins; a `resolved` with the pinned commit and another content hash is an integrity
 * failure; an `update` is stored with a diff the server computes itself from the snapshots.
 */
export async function applyPacksReport(
  ctx: Ctx,
  ws: { id: string; userId: string },
  msg: RunnerToServerOf<'packs.report'>,
): Promise<void> {
  const r = await one(ctx.pool, 'SELECT * FROM packs WHERE id=$1 AND removed_at IS NULL', [msg.packId]);
  if (!r) return;
  // a workstation reports only on packs it was sent: member of the organization, chosen by the admin who added the pack
  if (!(await workstationHoldsPack(ctx.pool, msg.packId, ws.id))) return;
  const orgId = r.org_id as string;
  const fromAdder = ws.userId === r.added_by;
  const base = { packId: msg.packId, orgId, workstationId: ws.id };
  const out: AppendInput[] = [];
  const m = msg as PacksReport;
  const mk = (type: string, payload: Record<string, unknown>) =>
    ({
      streamId: streamId.pack(msg.packId),
      event: { type, payload },
      actor: runnerActor(ws.id),
      scope: orgScope(orgId),
    }) as AppendInput;
  // The server never takes a reported content hash on trust: it is recomputed from the snapshot's own items, and a snapshot
  // whose hash does not match them is dropped.
  const snapshotOk = (s: PackSnapshot | undefined): s is PackSnapshot =>
    !!s && packSnapshotContentHash(s) === s.contentHash;
  if (m.state === 'resolved' && m.snapshot) {
    if (!snapshotOk(m.snapshot)) return;
    // the first resolution pins the commit and the content the owner will review: only the adding admin's own workstation may
    // supply it. Other chosen workstations can only confirm it afterwards.
    if (!r.pinned_sha) {
      if (fromAdder) out.push(mk('PackRefResolved', { ...base, snapshot: m.snapshot }));
    } else if (m.snapshot.sha === r.pinned_sha) {
      if (m.snapshot.contentHash !== r.content_hash)
        out.push(
          mk('PackIntegrityFailed', { ...base, expected: r.content_hash, actual: m.snapshot.contentHash }),
        );
      else if (r.status !== 'ready' || r.error || (await integrityFailedOn(ctx.pool, msg.packId, ws.id)))
        out.push(mk('PackRefResolved', { ...base, snapshot: m.snapshot }));
    }
  } else if (m.state === 'update' && m.snapshot) {
    if (!snapshotOk(m.snapshot) || !fromAdder) return;
    const have = r.update_snapshot as PackSnapshot | null;
    if (m.snapshot.sha !== r.pinned_sha && have?.sha !== m.snapshot.sha && r.snapshot)
      out.push(
        mk('PackUpdateAvailable', {
          ...base,
          snapshot: m.snapshot,
          diff: diffPackSnapshots(r.snapshot as PackSnapshot, m.snapshot),
        }),
      );
  } else if (m.state === 'current' && m.sha) {
    if (fromAdder) out.push(mk('PackUpToDate', { ...base, sha: m.sha, ref: r.ref }));
  } else if (m.state === 'integrity') {
    // only a fact about this workstation (the projection keeps it per workstation)
    if (!(await integrityFailedOn(ctx.pool, msg.packId, ws.id)))
      out.push(
        mk('PackIntegrityFailed', {
          ...base,
          expected: (m.expected ?? '').slice(0, 80),
          actual: (m.actual ?? '').slice(0, 80),
        }),
      );
  } else if (m.state === 'failed') {
    const message = (m.message ?? 'failed').slice(0, 500);
    if (r.error !== message)
      out.push(mk('PackFailed', { ...base, stage: r.pinned_sha ? 'check' : 'fetch', message }));
  }
  if (out.length) await ctx.store.append(out);
}

async function integrityFailedOn(db: Queryable, packId: string, workstationId: string): Promise<boolean> {
  return !!(await one(
    db,
    'SELECT 1 FROM pack_workstation_state WHERE pack_id=$1 AND workstation_id=$2 AND integrity_failed',
    [packId, workstationId],
  ));
}

/** `capabilities.project.report`: what a project's checkout carries. Only a member of the project's organization may report. */
export async function applyProjectCapabilitiesReport(
  ctx: Ctx,
  ws: { id: string; userId: string },
  msg: RunnerToServerOf<'capabilities.project.report'>,
): Promise<void> {
  const p = await one(ctx.pool, 'SELECT id, org_id FROM projects WHERE id=$1', [msg.projectId]);
  if (!p) return;
  if (!(await orgRoleOf(ctx.pool, ws.userId, p.org_id))) return;
  const m = msg as ProjectCapabilitiesReport;
  await ctx.store.append([
    {
      streamId: streamId.projectCapabilities(msg.projectId),
      event: {
        type: 'ProjectCapabilitiesReported',
        payload: {
          orgId: p.org_id,
          projectId: msg.projectId,
          workstationId: ws.id,
          items: m.items,
          issues: m.issues,
        },
      },
      actor: runnerActor(ws.id),
      scope: orgScope(p.org_id),
    } as AppendInput,
  ]);
}
