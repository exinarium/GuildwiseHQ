import { randomUUID } from 'node:crypto';
import {
  type CreateMyPackRequest,
  isOrgManager,
  type MyPackDto,
  type MyPacksResponse,
  PACK_AUTHORING_CAPABILITY,
  PackAuthorSaveResultSchema,
  PackBundleRequestResultSchema,
  type PackItem,
  PackReadResultSchema,
  type PackSnapshot,
  type ReadMyPackResult,
  type SaveMyPackRequest,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { applyHolders } from './pack-holders.ts';
import { authorWorkstationOf, HOLDS_PACK_SQL, packEvent, packWorkstations } from './pack-support.ts';
import { holdersOf } from './packs.ts';
import { deliver } from './workstation-setup.ts';

/**
 * "My capabilities": skills, personas and playbooks a member authors in Settings > Capabilities (docs/ARCHITECTURE.md section 38.8).
 * Everything authored is a real pack in the standard layout, held as a plain folder on the author's workstation. The browser seals
 * the files to that workstation's runner key; the server relays the ciphertext and never opens it, so it never stores authored
 * text: only metadata (names, descriptions, file hashes) like any pack snapshot.
 *
 * Visibility:
 *  - `private`: the files stay on that workstation. The metadata and every event are visible to the owner alone (user-scope
 *    events, owner-only queries); the pack is usable at once, with no review, by that workstation's sessions and by the agents the
 *    owner granted it to.
 *  - `org`: the author's workstation pins a revision; an Owner or Admin reviews and approves it like an imported pack (the author
 *    approves their own save only when they are an Owner or Admin and say so). Once approved it is listed for everyone and the
 *    holders the admin chose get the files from the author's workstation, sealed to their runner key.
 */

const MAX_MY_PACKS = 20;
const SAVE_TTL_MS = 24 * 3600_000;
const READ_TTL_MS = 5 * 60_000;

/** Reads for the editor: ciphertext sealed to the page's one-time key, kept in memory for a few minutes, never stored. */
const reads = new Map<
  string,
  {
    packId: string;
    userId: string;
    status: 'pending' | 'ready' | 'failed';
    ciphertext?: string;
    error?: string;
    at: number;
  }
>();
const sweepReads = (): void => {
  const cut = Date.now() - READ_TTL_MS;
  for (const [k, v] of reads) if (v.at < cut) reads.delete(k);
};

async function loadMine(
  db: Queryable,
  userId: string,
  orgId: string,
  id: string,
  lock = false,
): Promise<Row> {
  const r = await one(
    db,
    `SELECT p.* FROM packs p WHERE p.id=$1 AND p.org_id=$2 AND p.owner_user_id=$3 AND p.source='authored' AND p.removed_at IS NULL
        ${lock ? 'FOR UPDATE OF p' : ''}`,
    [id, orgId, userId],
  );
  // not yours (or not a pack at all): the same answer, so another member's private pack is not confirmed
  if (!r) throw notFound('pack not found');
  return r;
}

function stateOf(r: Row): MyPackDto['state'] {
  if (!r.pinned_sha) return 'draft';
  if (r.visibility === 'private') return 'private';
  return r.trusted && r.trusted_sha === r.pinned_sha && r.trusted_hash === r.content_hash
    ? 'trusted'
    : 'in_review';
}

export async function listMyPacks(ctx: Ctx, userId: string, orgId: string): Promise<MyPacksResponse> {
  const list = await rows(
    ctx.pool,
    `SELECT p.*, w.name AS ws_name, w.id AS ws_id,
            EXISTS (SELECT 1 FROM pack_workstation_state s WHERE s.pack_id = p.id AND s.integrity_failed) AS integrity_failed,
            COALESCE((SELECT array_agg(g.agent_id) FROM pack_agent_grants g WHERE g.pack_id = p.id), '{}') AS granted
       FROM packs p
       LEFT JOIN workstations w ON w.id = p.workstation_ids[1]
      WHERE p.org_id=$1 AND p.owner_user_id=$2 AND p.source='authored' AND p.removed_at IS NULL
      ORDER BY p.added_at`,
    [orgId, userId],
  );
  const holders = await holdersOf(ctx.pool, list, userId);
  const role = await orgRoleOf(ctx.pool, userId, orgId);
  const mine = await rows(
    ctx.pool,
    `SELECT w.id, w.name, ($3 = ANY(COALESCE(wc.capabilities, '{}'))) AS supported
       FROM workstations w LEFT JOIN workstation_capabilities wc ON wc.workstation_id = w.id
      WHERE w.user_id=$2 AND w.status='active' AND EXISTS (SELECT 1 FROM org_members om WHERE om.org_id=$1 AND om.user_id=$2 AND om.status='active')
      ORDER BY w.name, w.id`,
    [orgId, userId, PACK_AUTHORING_CAPABILITY],
  );
  const wsIds = list.map((p) => p.ws_id as string).filter(Boolean);
  const supported = new Map(mine.map((w) => [w.id, w.supported]));
  return {
    packs: list.map((p) => {
      const snap = p.snapshot as PackSnapshot | null;
      return {
        id: p.id,
        name: p.name,
        description: p.description ?? '',
        visibility: p.visibility,
        state: stateOf(p),
        workstationId: p.ws_id ?? '',
        workstationName: p.ws_name ?? '',
        workstationOnline: !!p.ws_id && ctx.services.runners.isOnline(p.ws_id),
        supported: !!supported.get(p.ws_id),
        revision: p.revision ?? 0,
        pinnedSha: p.pinned_sha ?? null,
        status: p.status,
        error: p.error ?? null,
        items: (snap?.items ?? []).map((i: PackItem) => ({
          kind: i.kind,
          key: i.key,
          name: i.name,
          description: i.description,
        })),
        hasScripts: !!p.has_scripts,
        saving: !!p.save_pending,
        update: p.update_snapshot
          ? {
              sha: (p.update_snapshot as PackSnapshot).sha,
              ref: (p.update_snapshot as PackSnapshot).ref,
              diff: p.update_diff,
              foundAt: iso(p.update_found_at) as string,
            }
          : null,
        mayApprove: isOrgManager({ orgRole: role }),
        holders: holders.get(p.id) ?? [],
        createdAt: iso(p.added_at) as string,
        grantedAgentIds: (p.granted ?? []) as string[],
      };
    }),
    workstations: mine.map((w) => ({
      id: w.id,
      name: w.name,
      online: ctx.services.runners.isOnline(w.id),
      supported: !!w.supported,
    })),
    ...(wsIds.length ? {} : {}),
  };
}

export async function createMyPack(
  ctx: Ctx,
  user: { id: string; displayName?: string },
  orgId: string,
  req: CreateMyPackRequest,
): Promise<MyPackDto> {
  if (['skill', 'persona', 'playbook', 'builtin', 'org', 'project', 'pack'].includes(req.name))
    throw badRequest('invalid_pack_name', 'choose another name for the pack');
  const id = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    const role = await orgRoleOf(tx, user.id, orgId);
    if (!role) throw notFound('organization not found');
    const ws = await one(
      tx,
      `SELECT id, name FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
      [req.workstationId, user.id],
    );
    if (!ws) throw notFound('workstation not found');
    const ok = (await packWorkstations(tx, orgId)).find((w) => w.id === ws.id);
    if (!ok?.authoring)
      throw badRequest('runner_too_old', 'update the runner on that workstation to author capabilities');
    const n = await one(
      tx,
      `SELECT count(*)::int AS n FROM packs WHERE org_id=$1 AND owner_user_id=$2 AND source='authored' AND removed_at IS NULL`,
      [orgId, user.id],
    );
    if ((n?.n ?? 0) >= MAX_MY_PACKS)
      throw conflict('too_many_packs', `at most ${MAX_MY_PACKS} authored packs`);
    const dup = await one(
      tx,
      req.visibility === 'org'
        ? `SELECT 1 FROM packs WHERE org_id=$1 AND name=$2 AND removed_at IS NULL AND visibility='org'`
        : `SELECT 1 FROM packs WHERE org_id=$1 AND name=$2 AND removed_at IS NULL AND visibility='private' AND owner_user_id=$3`,
      req.visibility === 'org' ? [orgId, req.name] : [orgId, req.name, user.id],
    );
    if (dup)
      throw conflict('pack_name_taken', `a pack named "${req.name}" already exists: choose another name`);
    await ctx.store.append(
      [
        packEvent(
          'PackAdded',
          {
            packId: id,
            orgId,
            name: req.name,
            url: `authored:${id}`,
            ref: 'authored',
            adapter: 'generic',
            scope: 'org',
            projectId: null,
            preset: null,
            addedBy: user.id,
            workstationIds: [req.workstationId],
            source: 'authored',
            visibility: req.visibility,
            ownerUserId: user.id,
            description: req.description,
            credentialKind: null,
          },
          { id, visibility: req.visibility, org_id: orgId, owner_user_id: user.id },
          user.id,
        ),
      ],
      { tx },
    );
  });
  const { syncWorkstations } = await import('./packs.ts');
  await syncWorkstations(ctx, [req.workstationId]);
  const mine = (await listMyPacks(ctx, user.id, orgId)).packs.find((p) => p.id === id);
  return mine as MyPackDto;
}

/** Saves the editor's files: sealed to the author's workstation, relayed in the durable command queue, never opened here. */
export async function saveMyPack(
  ctx: Ctx,
  userId: string,
  orgId: string,
  packId: string,
  req: SaveMyPackRequest,
): Promise<{ queued: true }> {
  let wsId = '';
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadMine(tx, userId, orgId, packId, true);
    wsId = authorWorkstationOf(p) as string;
    const k = await one(tx, 'SELECT key_id FROM workstation_keys WHERE workstation_id=$1', [wsId]);
    if (!k || k.key_id !== req.keyId)
      throw conflict('sudo_key_changed', "the runner's key changed: reload the page and save again");
    let approve = false;
    if (req.approve) {
      // an Owner or Admin approving their own save of an organization pack; nobody else can approve
      if (p.visibility !== 'org') throw badRequest('not_org_pack', 'only an organization pack is approved');
      if (!isOrgManager({ orgRole: await orgRoleOf(tx, userId, orgId) }))
        throw forbidden('only an Owner or Admin can approve their own pack: an Owner or Admin reviews yours');
      approve = true;
    }
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', payload='{}'::jsonb, last_error='superseded'
        WHERE workstation_id=$1 AND type='pack.author.save' AND status IN ('pending','sent') AND payload->>'packId' = $2`,
      [wsId, packId],
    );
    await enqueueRunnerCommand(
      tx,
      wsId,
      'pack.author.save',
      { packId, keyId: req.keyId, ciphertext: req.ciphertext, approve },
      new Date(ctx.clock.now().getTime() + SAVE_TTL_MS),
    );
    await ctx.store.append(
      [
        packEvent(
          'PackAuthoredSaveRequested',
          { packId, orgId, workstationId: wsId, requestedBy: userId, approve },
          p,
          userId,
        ),
      ],
      { tx },
    );
  });
  deliver(ctx, [wsId]);
  return { queued: true };
}

/** `command.result` of `pack.author.save`: the sealed files are forgotten; a refusal is shown to the author. */
export async function applyAuthorSaveResult(
  ctx: Ctx,
  workstationId: string,
  commandId: string,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
): Promise<void> {
  await exec(ctx.pool, `UPDATE runner_commands SET payload='{}'::jsonb WHERE id=$1`, [commandId]);
  const packId = String(payload.packId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(packId)) return;
  const p = await one(ctx.pool, 'SELECT * FROM packs WHERE id=$1 AND removed_at IS NULL', [packId]);
  if (!p || authorWorkstationOf(p) !== workstationId) return;
  const parsed = ok ? PackAuthorSaveResultSchema.safeParse(result) : undefined;
  if (parsed?.success && parsed.data.ok) return; // the runner's packs.report carries the outcome
  const msg = (parsed?.success ? parsed.data.error : undefined) ?? 'the workstation could not save the pack';
  await ctx.store.append([
    packEvent(
      'PackFailed',
      { packId, orgId: p.org_id, workstationId, stage: 'save', message: msg.slice(0, 500) },
      p,
      {
        workstationId,
      },
    ),
  ]);
}

// ------------------------------------------------------------------------------------------------ reading for the editor

export async function startReadMyPack(
  ctx: Ctx,
  userId: string,
  orgId: string,
  packId: string,
  replyKey: string,
): Promise<{ requestId: string }> {
  sweepReads();
  const p = await loadMine(ctx.pool, userId, orgId, packId);
  const wsId = authorWorkstationOf(p) as string;
  const requestId = randomUUID();
  reads.set(requestId, { packId, userId, status: 'pending', at: Date.now() });
  await enqueueRunnerCommand(
    ctx.pool,
    wsId,
    'pack.read',
    { packId, requestId, replyKey },
    new Date(Date.now() + READ_TTL_MS),
  );
  deliver(ctx, [wsId]);
  return { requestId };
}

export function getReadMyPack(userId: string, requestId: string): ReadMyPackResult {
  sweepReads();
  const r = reads.get(requestId);
  // somebody else's request id reads as unknown
  if (!r || r.userId !== userId) throw notFound('request not found');
  return {
    status: r.status,
    ...(r.ciphertext ? { ciphertext: r.ciphertext } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

/** `command.result` of `pack.read`: the ciphertext (sealed to the page) waits in memory for the page to fetch it. */
export function applyReadResult(payload: Record<string, unknown>, ok: boolean, result: unknown): void {
  const id = String(payload.requestId ?? '');
  const r = reads.get(id);
  if (!r) return;
  const parsed = ok ? PackReadResultSchema.safeParse(result) : undefined;
  if (parsed?.success && parsed.data.ok && parsed.data.ciphertext) {
    r.status = 'ready';
    r.ciphertext = parsed.data.ciphertext;
  } else {
    r.status = 'failed';
    r.error = (parsed?.success ? parsed.data.error : undefined) ?? 'the workstation could not read the pack';
  }
}

// ------------------------------------------------------------------------------------------------ visibility and grants

export async function setMyPackVisibility(
  ctx: Ctx,
  userId: string,
  orgId: string,
  packId: string,
  visibility: 'org' | 'private',
): Promise<void> {
  let sync: string[] = [];
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadMine(tx, userId, orgId, packId, true);
    if (p.visibility === visibility) return;
    const author = authorWorkstationOf(p) as string;
    if (visibility === 'org') {
      const dup = await one(
        tx,
        `SELECT 1 FROM packs WHERE org_id=$1 AND name=$2 AND removed_at IS NULL AND visibility='org' AND id <> $3`,
        [orgId, p.name, packId],
      );
      if (dup)
        throw conflict(
          'pack_name_taken',
          `an organization pack named "${p.name}" already exists: rename yours first`,
        );
    }
    // events of the old audience first (the change itself is announced to the new one)
    await ctx.store.append(
      [
        packEvent(
          'PackVisibilityChanged',
          { packId, orgId, visibility, changedBy: userId },
          { ...p, visibility },
          userId,
        ),
        // a pack made private goes back to the author's workstation alone
        ...(visibility === 'private'
          ? [
              packEvent(
                'PackWorkstationsChanged',
                { packId, orgId, workstationIds: [author], changedBy: userId },
                { ...p, visibility },
                userId,
              ),
            ]
          : []),
      ],
      { tx },
    );
    sync = [...((p.workstation_ids as string[]) ?? []), author];
  });
  const { syncWorkstations } = await import('./packs.ts');
  if (sync.length) await syncWorkstations(ctx, sync);
}

export async function grantPackAgent(
  ctx: Ctx,
  userId: string,
  orgId: string,
  packId: string,
  agentId: string,
  granted: boolean,
): Promise<void> {
  let ws = '';
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadMine(tx, userId, orgId, packId, true);
    if (p.visibility !== 'private')
      throw badRequest(
        'not_private',
        'only a private pack is granted to agents; an organization pack is listed for everyone',
      );
    // the workstation owner grants it to an agent that runs on their own workstation
    const a = await one(
      tx,
      `SELECT a.id, a.workstation_id FROM agents a WHERE a.id=$1 AND a.org_id=$2 AND a.status <> 'retired'`,
      [agentId, orgId],
    );
    if (!a || a.workstation_id !== authorWorkstationOf(p))
      throw notFound('agent not found on that workstation');
    ws = a.workstation_id;
    await ctx.store.append(
      [packEvent('PackAgentGranted', { packId, orgId, agentId, grantedBy: userId, granted }, p, userId)],
      { tx },
    );
  });
  const { syncWorkstations } = await import('./packs.ts');
  await syncWorkstations(ctx, [ws]);
}

export async function removeMyPack(ctx: Ctx, userId: string, orgId: string, packId: string): Promise<void> {
  let ws: string[] = [];
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadMine(tx, userId, orgId, packId, true);
    ws = (p.workstation_ids as string[]) ?? [];
    await ctx.store.append([packEvent('PackRemoved', { packId, orgId, removedBy: userId }, p, userId)], {
      tx,
    });
  });
  const { syncWorkstations } = await import('./packs.ts');
  await syncWorkstations(ctx, ws);
}

// ------------------------------------------------------------------------------------------------ relay to other holders

/**
 * An approved authored organization pack lives on its author's workstation; the other holders get the pinned revision from there,
 * sealed to their own runner key (the server relays ciphertext and keeps nothing). Called when the pack is approved, accepted at a
 * new revision, when a holder accepted the pack, and when the author's workstation connects.
 */
export async function relayAuthoredBundles(ctx: Ctx, packId: string): Promise<void> {
  const p = await one(
    ctx.pool,
    `SELECT * FROM packs WHERE id=$1 AND removed_at IS NULL AND source='authored' AND visibility='org'`,
    [packId],
  );
  if (!p?.pinned_sha) return;
  // untrusted content never leaves the author's workstation
  if (!(p.trusted && p.trusted_sha === p.pinned_sha && p.trusted_hash === p.content_hash)) return;
  const author = authorWorkstationOf(p);
  if (!author || !ctx.services.runners.isOnline(author)) return;
  const targets = await rows(
    ctx.pool,
    `SELECT w.id AS workstation_id, k.key_id, k.public_key FROM packs p
       JOIN workstations w ON w.id <> $2
       JOIN workstation_keys k ON k.workstation_id = w.id
       JOIN workstation_capabilities wc ON wc.workstation_id = w.id AND $3 = ANY(wc.capabilities)
       LEFT JOIN pack_workstation_state st ON st.pack_id = p.id AND st.workstation_id = w.id
      WHERE p.id = $1 AND ${HOLDS_PACK_SQL}
        AND (st.content_sha IS DISTINCT FROM p.pinned_sha)`,
    [packId, author, PACK_AUTHORING_CAPABILITY],
  );
  if (!targets.length) return;
  const pending = await one(
    ctx.pool,
    `SELECT 1 FROM runner_commands WHERE workstation_id=$1 AND type='pack.bundle.request' AND status IN ('pending','sent')
        AND payload->>'packId' = $2 AND payload->>'sha' = $3`,
    [author, packId, p.pinned_sha],
  );
  if (pending) return;
  await enqueueRunnerCommand(
    ctx.pool,
    author,
    'pack.bundle.request',
    {
      packId,
      sha: p.pinned_sha,
      targets: targets.map((t) => ({
        workstationId: t.workstation_id,
        keyId: t.key_id,
        publicKey: t.public_key,
      })),
    },
    new Date(Date.now() + SAVE_TTL_MS),
  );
  deliver(ctx, [author]);
}

/** Packs whose files the connecting workstation is the author of: the others may be waiting for them. */
export async function relayForAuthor(ctx: Ctx, workstationId: string): Promise<void> {
  const list = await rows(
    ctx.pool,
    `SELECT id FROM packs WHERE removed_at IS NULL AND source='authored' AND visibility='org' AND workstation_ids[1] = $1`,
    [workstationId],
  );
  for (const p of list) await relayAuthoredBundles(ctx, p.id);
}

/** `command.result` of `pack.bundle.request`: each sealed bundle goes on to its workstation as `pack.bundle.put`. */
export async function applyBundleRequestResult(
  ctx: Ctx,
  workstationId: string,
  commandId: string,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
): Promise<void> {
  await exec(ctx.pool, `UPDATE runner_commands SET payload='{}'::jsonb WHERE id=$1`, [commandId]);
  const parsed = ok ? PackBundleRequestResultSchema.safeParse(result) : undefined;
  if (!parsed?.success || !parsed.data.ok || !parsed.data.contentHash) return;
  const packId = String(payload.packId ?? '');
  const sha = String(payload.sha ?? '');
  const p = await one(
    ctx.pool,
    `SELECT * FROM packs WHERE id=$1 AND removed_at IS NULL AND source='authored'`,
    [packId],
  );
  // only for what is still approved: a revoked or replaced revision is dropped
  if (
    !p ||
    p.pinned_sha !== sha ||
    p.content_hash !== parsed.data.contentHash ||
    authorWorkstationOf(p) !== workstationId
  )
    return;
  if (!(p.trusted && p.trusted_sha === sha && p.trusted_hash === p.content_hash)) return;
  const sent: string[] = [];
  for (const b of parsed.data.bundles) {
    const holds = await one(
      ctx.pool,
      `SELECT k.key_id FROM packs p JOIN workstations w ON w.id = $2 JOIN workstation_keys k ON k.workstation_id = w.id WHERE p.id = $1 AND ${HOLDS_PACK_SQL}`,
      [packId, b.workstationId],
    );
    if (!holds) continue;
    await enqueueRunnerCommand(
      ctx.pool,
      b.workstationId,
      'pack.bundle.put',
      { packId, sha, contentHash: parsed.data.contentHash, keyId: holds.key_id, ciphertext: b.ciphertext },
      new Date(Date.now() + SAVE_TTL_MS),
    );
    sent.push(b.workstationId);
  }
  deliver(ctx, sent);
}
