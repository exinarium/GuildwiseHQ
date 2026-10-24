import { randomUUID } from 'node:crypto';
import {
  type AddPackRequest,
  diffPackSnapshots,
  isOrgManager,
  PACK_AUTHORING_CAPABILITY,
  PACK_PRESETS,
  PACKS_CAPABILITY,
  type PackCredentialShares,
  type PackDesiredInput,
  type PackDetailDto,
  type PackDto,
  type PackHolder,
  type PackSnapshot,
  type PacksReport,
  type PacksResponse,
  PackUrlSchema,
  type ProjectCapabilitiesReport,
  packSnapshotContentHash,
  type RunnerToServerOf,
  type SetPackWorkstationsRequest,
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
import { relayAuthoredBundles } from './pack-authoring.ts';
import { offerRoleUpdates } from './pack-hire.ts';
import { applyHolders, type HolderChange } from './pack-holders.ts';
import {
  authorWorkstationOf,
  HOLDS_PACK_SQL,
  isTrustedRow,
  packEvent,
  packWorkstations,
  wsHas,
} from './pack-support.ts';
import { refreshProjectSkillsNotice } from './project-skills-notice.ts';
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

export function dto(r: Row, holders: PackHolder[] = [], ownerName: string | null = null): PackDto {
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
    trusted: isTrustedRow(r) && !!r.pinned_sha,
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
    source: r.source ?? 'git',
    visibility: r.visibility ?? 'org',
    ownerUserId: r.owner_user_id ?? null,
    ownerName,
    description: r.description ?? '',
    credentialKind: r.credential_kind ?? null,
    credentialFingerprint: r.credential_fingerprint ?? null,
    revision: r.revision ?? 0,
    holders,
  };
}

/** The workstations that hold (or are asked to hold) each pack, with the opt-in and credential state, for the pack pages. */
export async function holdersOf(
  db: Queryable,
  packRows: Row[],
  viewerUserId: string,
): Promise<Map<string, PackHolder[]>> {
  const out = new Map<string, PackHolder[]>();
  if (!packRows.length) return out;
  const ids = packRows.map((p) => p.id);
  const ws = await rows(
    db,
    `SELECT p.id AS pack_id, w.id AS workstation_id, w.name, u.display_name AS owner_name, w.user_id,
            pa.status AS assignment, cs.status AS cred_status, cs.error AS cred_error,
            COALESCE(st.host_key_pinned, false) AS host_key_pinned, (st.content_sha IS NOT NULL AND st.content_sha = p.pinned_sha) AS has_content
       FROM packs p
       JOIN workstations w ON (w.id = ANY(p.workstation_ids) OR (cardinality(p.workstation_ids) = 0 AND w.user_id = p.added_by))
       JOIN users u ON u.id = w.user_id
       LEFT JOIN pack_assignments pa ON pa.pack_id = p.id AND pa.workstation_id = w.id
       LEFT JOIN pack_credential_shares cs ON cs.pack_id = p.id AND cs.workstation_id = w.id
       LEFT JOIN pack_workstation_state st ON st.pack_id = p.id AND st.workstation_id = w.id
      WHERE p.id = ANY($1::uuid[]) AND w.status = 'active'
      ORDER BY w.name, w.id`,
    [ids],
  );
  for (const r of ws) {
    const list = out.get(r.pack_id) ?? [];
    list.push({
      workstationId: r.workstation_id,
      workstationName: r.name,
      ownerName: r.owner_name,
      mine: r.user_id === viewerUserId,
      assignment: r.assignment === 'pending' ? 'pending' : 'accepted',
      credential: r.cred_status
        ? r.cred_status === 'stored'
          ? 'stored'
          : r.cred_status === 'failed'
            ? 'failed'
            : 'pending'
        : null,
      credentialError: r.cred_error ?? null,
      hostKeyPinned: !!r.host_key_pinned,
      hasContent: !!r.has_content,
    });
    out.set(r.pack_id, list);
  }
  return out;
}

async function packDto(ctx: Ctx, who: Who, id: string): Promise<PackDto> {
  const r = await load(ctx.pool, who, id);
  const holders = await holdersOf(ctx.pool, [r], who.userId);
  return dto(r, holders.get(r.id) ?? []);
}

async function load(db: Queryable, who: Who, id: string, lock = false): Promise<Row> {
  const r = await one(
    db,
    `SELECT p.*, ${INTEGRITY_SQL} AS integrity_failed FROM packs p
      WHERE p.id=$1 AND p.org_id=$2 AND p.removed_at IS NULL AND p.visibility = 'org' ${lock ? 'FOR UPDATE OF p' : ''}`,
    [id, who.orgId],
  );
  // A private pack is not found here whoever asks: only its owner's "My capabilities" sees it.
  if (!r) throw notFound('pack not found');
  return r;
}

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
export async function desiredPacksFor(db: Queryable, workstationId: string): Promise<PackDesiredInput[]> {
  // A runner from before R3a cannot hold an authored pack, a private pack or one that needs a deploy key: it is not sent them
  // (its schema would not even read the URL of an authored pack).
  const authoring = await wsHas(db, workstationId, PACK_AUTHORING_CAPABILITY);
  const r = await rows(
    db,
    `SELECT p.*, COALESCE((SELECT array_agg(g.agent_id) FROM pack_agent_grants g
                            JOIN agents a ON a.id = g.agent_id AND a.workstation_id = w.id AND a.status <> 'retired'
                           WHERE g.pack_id = p.id), '{}') AS granted_agent_ids
       FROM packs p JOIN workstations w ON w.id = $1
      WHERE p.removed_at IS NULL AND ${HOLDS_PACK_SQL}
        AND ($2::boolean OR (p.source = 'git' AND p.visibility = 'org' AND p.credential_kind IS NULL))
      ORDER BY p.added_at`,
    [workstationId, authoring],
  );
  return r.map((p) => ({
    // The R3a fields appear only when they are not the defaults: a plain public pack is sent exactly as before.
    ...(p.source === 'authored'
      ? { source: 'authored' as const, authorWorkstationId: authorWorkstationOf(p) }
      : {}),
    ...(p.visibility === 'private'
      ? {
          visibility: 'private' as const,
          ownerUserId: p.owner_user_id ?? null,
          grantedAgentIds: (p.granted_agent_ids ?? []) as string[],
        }
      : {}),
    ...(p.credential_kind ? { credentialKind: p.credential_kind, hostKey: p.host_key ?? null } : {}),
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
      p.trusted && p.trusted_sha && p.trusted_hash && p.visibility !== 'private'
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
    reviewed: await reviewedProjectCapabilities(db, workstationId),
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

/**
 * The project-repository capabilities an Owner or Admin reviewed (at the hash that was reviewed), in the organizations this
 * workstation's owner belongs to. The runner serves a capability read from a project's repository only if it is listed here
 * at its current content hash (Q52): unreviewed and changed ones are unusable.
 */
export async function reviewedProjectCapabilities(
  db: Queryable,
  workstationId: string,
): Promise<Array<{ projectId: string; kind: 'skill' | 'persona' | 'playbook'; key: string; hash: string }>> {
  const r = await rows(
    db,
    `SELECT cr.project_id, cr.kind, cr.key, cr.hash FROM capability_reviews cr
       JOIN workstations w ON w.id = $1
       JOIN org_members om ON om.user_id = w.user_id AND om.org_id = cr.org_id AND om.status = 'active'
      WHERE cr.status = 'reviewed' ORDER BY cr.project_id, cr.kind, cr.key LIMIT 3000`,
    [workstationId],
  );
  return r.map((x) => ({ projectId: x.project_id, kind: x.kind, key: x.key, hash: x.hash }));
}

export async function syncOrg(ctx: Ctx, orgId: string): Promise<void> {
  const ws = await packWorkstations(ctx.pool, orgId);
  for (const w of ws) await queuePacksSync(ctx.pool, w.id);
  deliver(
    ctx,
    ws.map((w) => w.id),
  );
}

/** The full list for these workstations only (a private pack, a changed holder). */
export async function syncWorkstations(ctx: Ctx, workstationIds: string[]): Promise<void> {
  for (const id of new Set(workstationIds)) await queuePacksSync(ctx.pool, id);
  deliver(ctx, [...new Set(workstationIds)]);
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
  // A private pack is not here whoever asks, nor is an authored organization pack its author has not saved yet.
  const r = await rows(
    ctx.pool,
    `SELECT p.*, ${INTEGRITY_SQL} AS integrity_failed, u.display_name AS owner_name FROM packs p
       LEFT JOIN users u ON u.id = p.owner_user_id
      WHERE p.org_id=$1 AND p.removed_at IS NULL AND p.visibility = 'org' AND NOT (p.source = 'authored' AND p.pinned_sha IS NULL)
      ORDER BY p.added_at`,
    [who.orgId],
  );
  const ws = await packWorkstations(ctx.pool, who.orgId);
  const holders = await holdersOf(ctx.pool, r, who.userId);
  return {
    packs: r.map((p) => dto(p, holders.get(p.id) ?? [], p.owner_name ?? null)),
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
  const holders = await holdersOf(ctx.pool, [r], who.userId);
  const owner = r.owner_user_id
    ? await one(ctx.pool, 'SELECT display_name FROM users WHERE id=$1', [r.owner_user_id])
    : undefined;
  return {
    ...dto(r, holders.get(r.id) ?? [], owner?.display_name ?? null),
    snapshot: r.snapshot ?? null,
    updateSnapshot: r.update_snapshot ?? null,
  };
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
  const id = req.id ?? randomUUID();
  let change: HolderChange | undefined;
  const chosen = [...new Set(req.workstationIds ?? [])];
  // A private repository: ssh needs a deploy key, https a token; without a credential only a public https URL is accepted.
  const cred = req.credential;
  if (!cred && !PackUrlSchema.safeParse(req.url).success)
    throw badRequest(
      'invalid_url',
      'use a public https:// URL, or add a deploy key or token for a private repository',
    );
  if (cred) {
    const ssh = /^(ssh:\/\/|git@)/i.test(req.url);
    if (cred.kind === 'ssh' && !ssh)
      throw badRequest(
        'invalid_url',
        'a deploy key is for an ssh URL (ssh://git@host/path or git@host:path)',
      );
    if (cred.kind === 'token' && ssh)
      throw badRequest('invalid_url', 'a token is for an https:// URL; use a deploy key for ssh');
    if (!chosen.length)
      throw badRequest('workstations_required', 'choose the workstations that get the deploy key or token');
  }
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
    // a browser-chosen id (so a credential can be sealed bound to it) must be new
    if (req.id && (await one(tx, 'SELECT 1 FROM packs WHERE id=$1', [id])))
      throw conflict('pack_id_taken', 'choose another pack id');
    const n = await one(tx, 'SELECT count(*)::int AS n FROM packs WHERE org_id=$1 AND removed_at IS NULL', [
      who.orgId,
    ]);
    if ((n?.n ?? 0) >= MAX_PACKS) throw conflict('too_many_packs', `at most ${MAX_PACKS} packs`);
    const dup = await one(
      tx,
      `SELECT 1 FROM packs WHERE org_id=$1 AND name=$2 AND removed_at IS NULL AND visibility='org'`,
      [who.orgId, name],
    );
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
            // the holders are set below, so that another member's workstation goes through the opt-in
            workstationIds: [],
            credentialKind: cred?.kind ?? null,
          },
          who.orgId,
          id,
          who.userId,
        ),
      ],
      { tx },
    );
    if (chosen.length) {
      const pack = await one(tx, 'SELECT * FROM packs WHERE id=$1', [id]);
      const me = await one(tx, 'SELECT display_name FROM users WHERE id=$1', [who.userId]);
      change = await applyHolders(
        ctx,
        tx,
        pack as Row,
        { userId: who.userId, name: me?.display_name },
        chosen,
        cred,
      );
    }
  });
  await syncOrg(ctx, who.orgId);
  if (change) deliver(ctx, change.deliver);
  return packDto(ctx, who, id);
}

/** The admin changes who holds the pack; a workstation of another member waits for that member to accept. */
export async function setPackWorkstations(
  ctx: Ctx,
  who: Who,
  id: string,
  req: SetPackWorkstationsRequest,
): Promise<PackDto> {
  requireManager(who);
  let change: HolderChange | undefined;
  await withAppendTx(ctx.pool, async (tx) => {
    const pack = await load(tx, who, id, true);
    const ids = [...new Set(req.workstationIds)];
    const ok = await packWorkstations(tx, who.orgId);
    const known = new Map(ok.map((w) => [w.id, w]));
    if (pack.source === 'authored') {
      // the author's workstation always holds it (and stays first): it is the source of the files
      const author = authorWorkstationOf(pack);
      if (!author || !ids.includes(author))
        throw badRequest('author_workstation_required', "an authored pack stays on its author's workstation");
      ids.splice(ids.indexOf(author), 1);
      ids.unshift(author);
    } else if (!ids.some((c) => known.get(c)?.user_id === pack.added_by)) {
      throw badRequest('own_workstation_required', 'keep one of the adding admin’s own workstations');
    }
    const me = await one(tx, 'SELECT display_name FROM users WHERE id=$1', [who.userId]);
    change = await applyHolders(
      ctx,
      tx,
      pack,
      { userId: who.userId, name: me?.display_name },
      ids,
      req.credential,
    );
  });
  await syncOrg(ctx, who.orgId);
  if (change) deliver(ctx, change.deliver);
  // an approved authored pack goes to the holders that were added
  await relayAuthoredBundles(ctx, id);
  return packDto(ctx, who, id);
}

/** Replaces the deploy key or token of a private repository on every holder (rotation). */
export async function setPackCredential(
  ctx: Ctx,
  who: Who,
  id: string,
  cred: PackCredentialShares,
): Promise<PackDto> {
  requireManager(who);
  let change: HolderChange | undefined;
  await withAppendTx(ctx.pool, async (tx) => {
    const pack = await load(tx, who, id, true);
    if (pack.source !== 'git') throw badRequest('not_a_git_pack', 'only a git pack has a credential');
    const ssh = /^(ssh:\/\/|git@)/i.test(pack.url);
    if ((cred.kind === 'ssh') !== ssh)
      throw badRequest(
        'invalid_url',
        ssh ? 'this repository uses ssh: use a deploy key' : 'this repository uses https: use a token',
      );
    const me = await one(tx, 'SELECT display_name FROM users WHERE id=$1', [who.userId]);
    change = await applyHolders(
      ctx,
      tx,
      pack,
      { userId: who.userId, name: me?.display_name },
      (pack.workstation_ids as string[]).length
        ? (pack.workstation_ids as string[])
        : cred.shares.map((s) => s.workstationId),
      cred,
    );
  });
  await syncOrg(ctx, who.orgId);
  if (change) deliver(ctx, change.deliver);
  return packDto(ctx, who, id);
}

export async function checkPack(ctx: Ctx, who: Who, id: string, ref?: string): Promise<{ queued: boolean }> {
  requireManager(who);
  const r = await load(ctx.pool, who, id);
  if (r.source === 'authored')
    throw conflict('no_remote', 'an authored pack has no remote: its updates are the author’s saves');
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
        // agents hired from a persona this update changed: a new role version is on offer (never applied by itself)
        ...(await offerRoleUpdates(ctx, tx, r, r.snapshot as PackSnapshot | null, up)),
      ],
      { tx },
    );
  });
  await syncOrg(ctx, who.orgId);
  await relayAuthoredBundles(ctx, id);
  return packDto(ctx, who, id);
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
  // an authored pack is approved on its author's workstation: the other holders may now receive the files
  await relayAuthoredBundles(ctx, id);
  return packDto(ctx, who, id);
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
  return packDto(ctx, who, id);
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
  return packDto(ctx, who, id);
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
  // a workstation reports only on packs it was sent: member of the organization, chosen by the admin who added the pack, and (for
  // another member's workstation) accepted by that member; a private pack only from its owner's workstation
  if (!(await workstationHoldsPack(ctx.pool, msg.packId, ws.id))) return;
  const orgId = r.org_id as string;
  const authored = r.source === 'authored';
  // who may pin and offer updates: the adding admin's workstation, or an authored pack's author workstation
  const fromAdder = authored ? authorWorkstationOf(r) === ws.id : ws.userId === r.added_by;
  const base = { packId: msg.packId, orgId, workstationId: ws.id };
  const out: AppendInput[] = [];
  const m = msg as PacksReport;
  const mk = (type: string, payload: Record<string, unknown>) =>
    packEvent(type, payload, r as never, { workstationId: ws.id });
  // The server never takes a reported content hash on trust: it is recomputed from the snapshot's own items, and a snapshot
  // whose hash does not match them is dropped.
  const snapshotOk = (s: PackSnapshot | undefined): s is PackSnapshot =>
    !!s && packSnapshotContentHash(s) === s.contentHash;
  // An authored revision is named by its content hash: a snapshot whose sha is something else is not one of ours.
  const authoredOk = (s: PackSnapshot): boolean => !authored || s.sha === s.contentHash;
  // The workstation is waiting (for the member's opt-in, a credential, the files): a fact, not a failure.
  if (m.waiting) return;
  // The ssh host key the first fetch recorded: remembered once, so a re-installed runner keeps the pin.
  if (m.hostKey && r.credential_kind === 'ssh' && !r.host_key)
    out.push(
      mk('PackHostKeyPinned', {
        ...base,
        host: m.hostKey.host.slice(0, 255),
        hostKey: m.hostKey.key.slice(0, 2000),
      }),
    );
  // Anyone who may approve their own save: an Owner or Admin who asked for it when saving.
  const ownerMayApprove = async (): Promise<boolean> =>
    authored &&
    r.visibility === 'org' &&
    !!r.save_approve &&
    !!r.owner_user_id &&
    isOrgManager({ orgRole: await orgRoleOf(ctx.pool, r.owner_user_id, orgId) });
  let accepted = false;
  if (m.state === 'resolved' && m.snapshot) {
    if (!snapshotOk(m.snapshot) || !authoredOk(m.snapshot)) return;
    // the first resolution pins the commit and the content the owner will review: only the adding admin's own workstation may
    // supply it. Other chosen workstations can only confirm it afterwards.
    if (!r.pinned_sha) {
      if (fromAdder) {
        out.push(mk('PackRefResolved', { ...base, snapshot: m.snapshot }));
        // an Owner or Admin who approves their own pack: the same save is the review
        if (await ownerMayApprove())
          out.push(
            mk('PackTrusted', {
              packId: msg.packId,
              orgId,
              sha: m.snapshot.sha,
              contentHash: m.snapshot.contentHash,
              trustedBy: r.owner_user_id,
            }),
          );
      }
    } else if (m.snapshot.sha === r.pinned_sha) {
      if (m.snapshot.contentHash !== r.content_hash)
        out.push(
          mk('PackIntegrityFailed', { ...base, expected: r.content_hash, actual: m.snapshot.contentHash }),
        );
      else if (
        r.status !== 'ready' ||
        r.error ||
        (await integrityFailedOn(ctx.pool, msg.packId, ws.id)) ||
        // an authored organization pack travels to the others: note which workstation holds the pinned revision now
        (authored && !(await holdsContent(ctx.pool, msg.packId, ws.id, r.pinned_sha)))
      )
        out.push(mk('PackRefResolved', { ...base, snapshot: m.snapshot }));
    }
  } else if (m.state === 'update' && m.snapshot) {
    if (!snapshotOk(m.snapshot) || !authoredOk(m.snapshot) || !fromAdder) return;
    const have = r.update_snapshot as PackSnapshot | null;
    if (m.snapshot.sha !== r.pinned_sha && have?.sha !== m.snapshot.sha && r.snapshot) {
      const diff = diffPackSnapshots(r.snapshot as PackSnapshot, m.snapshot);
      out.push(mk('PackUpdateAvailable', { ...base, snapshot: m.snapshot, diff }));
      // The author's own pack takes its new revision at once when it is private (it is theirs) or when an Owner or Admin
      // approved their own save; a Member's organization pack waits for an Owner or Admin, with the diff, like any update.
      const approve = await ownerMayApprove();
      if (authored && (r.visibility === 'private' || approve)) {
        accepted = true;
        out.push(
          mk('PackUpdateAccepted', {
            packId: msg.packId,
            orgId,
            sha: m.snapshot.sha,
            ref: m.snapshot.ref,
            contentHash: m.snapshot.contentHash,
            acceptedBy: r.owner_user_id,
            keepTrust: false,
            scriptsReset: diff.scriptsAdded.length + diff.scriptsChanged.length > 0,
          }),
        );
        if (approve)
          out.push(
            mk('PackTrusted', {
              packId: msg.packId,
              orgId,
              sha: m.snapshot.sha,
              contentHash: m.snapshot.contentHash,
              trustedBy: r.owner_user_id,
            }),
          );
        out.push(...(await offerRoleUpdates(ctx, ctx.pool, r, r.snapshot as PackSnapshot, m.snapshot)));
      }
    }
  } else if (m.state === 'current' && m.sha) {
    // a save of the same files: nothing to offer, and the pending save is over
    if (authored && r.save_pending) {
      out.push(mk('PackUpToDate', { ...base, sha: m.sha, ref: r.ref }));
    } else if (fromAdder && !authored) out.push(mk('PackUpToDate', { ...base, sha: m.sha, ref: r.ref }));
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
  // the new revision (or the first pin, or the approval) goes to the holders
  if (out.length && authored) {
    if (r.visibility === 'private')
      await syncWorkstations(ctx, ((r.workstation_ids as string[]) ?? []).slice(0, 1));
    else {
      if (accepted || out.some((e) => e.event.type === 'PackRefResolved' || e.event.type === 'PackTrusted'))
        await syncOrg(ctx, orgId);
      await relayAuthoredBundles(ctx, msg.packId);
    }
  }
}

async function holdsContent(
  db: Queryable,
  packId: string,
  workstationId: string,
  sha: string,
): Promise<boolean> {
  return !!(await one(
    db,
    'SELECT 1 FROM pack_workstation_state WHERE pack_id=$1 AND workstation_id=$2 AND content_sha=$3',
    [packId, workstationId, sha],
  ));
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
  // Anything new or changed in the repository waits for an Owner's or Admin's review (Q52): a desk notice says so.
  await refreshProjectSkillsNotice(ctx, p.org_id, msg.projectId).catch((err) =>
    ctx.log.warn({ err }, 'project skills notice failed'),
  );
}
