import { randomUUID } from 'node:crypto';
import {
  PACK_AUTHORING_CAPABILITY,
  type PackAssignmentDto,
  type PackCredentialKind,
  PackCredentialResultSchema,
  type PackCredentialShares,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { orgScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { packEvent, packWorkstations, wsHas } from './pack-support.ts';

/**
 * Who holds a pack, member opt-in and the deploy key or token of a private git pack (docs/ARCHITECTURE.md section 38.8).
 *
 *  - The admin chooses the workstations. Their own need no opt-in. A workstation of another member gets a desk item
 *    (`pack_assignment`, addressed to that member): until the member accepts, `packs.sync` does not list the pack for it, so
 *    nothing is cloned and no credential is sent; declining removes the assignment (and the workstation from the pack's holders).
 *  - A credential is sealed in the browser to each chosen workstation separately. The server stores a ciphertext only while it
 *    waits (`held` for the opt-in, `queued` for the runner), empties it once the runner answered, and never opens it.
 */

export const PACK_ASSIGNMENT_SUBKIND = 'pack_assignment';
const CREDENTIAL_TTL_MS = 24 * 3600_000;

type Pack = Row;

/** Cancels a credential command that has not been delivered yet (a newer share or a removal replaces it). */
async function supersedeCredential(db: Queryable, workstationId: string, packId: string): Promise<void> {
  await exec(
    db,
    `UPDATE runner_commands SET status='failed', payload='{}'::jsonb, last_error='superseded'
      WHERE workstation_id=$1 AND type='pack.credential.set' AND status IN ('pending','sent') AND payload->>'packId' = $2`,
    [workstationId, packId],
  );
}

async function queueCredential(
  ctx: Ctx,
  tx: Tx,
  a: { packId: string; workstationId: string; kind: PackCredentialKind; username?: string | undefined },
): Promise<void> {
  const share = await one(
    tx,
    'SELECT key_id, ciphertext FROM pack_credential_shares WHERE pack_id=$1 AND workstation_id=$2',
    [a.packId, a.workstationId],
  );
  if (!share?.ciphertext) return;
  await supersedeCredential(tx, a.workstationId, a.packId);
  await enqueueRunnerCommand(
    tx,
    a.workstationId,
    'pack.credential.set',
    {
      packId: a.packId,
      keyId: share.key_id,
      kind: a.kind,
      ciphertext: share.ciphertext,
      ...(a.username ? { username: a.username } : {}),
    },
    new Date(ctx.clock.now().getTime() + CREDENTIAL_TTL_MS),
  );
  await exec(
    tx,
    `UPDATE pack_credential_shares SET status='queued', error=NULL, updated_at=$3 WHERE pack_id=$1 AND workstation_id=$2`,
    [a.packId, a.workstationId, ctx.clock.now()],
  );
}

export interface HolderChange {
  /** Workstations to deliver queued commands to after the transaction commits. */
  deliver: string[];
  /** Workstations whose `packs.sync` must be refreshed. */
  sync: string[];
}

/**
 * Sets the holders of a pack (the order matters for an authored pack: the first is the author's workstation) and, for a pack with
 * a credential, stores one sealed share per holder. Call inside the transaction that appended `PackAdded`, or on its own for a
 * change of holders.
 */
export async function applyHolders(
  ctx: Ctx,
  tx: Tx,
  pack: Pack,
  by: { userId: string; name?: string },
  newIds: string[],
  credential?: PackCredentialShares,
): Promise<HolderChange> {
  const known = new Map((await packWorkstations(tx, pack.org_id)).map((w) => [w.id, w]));
  const wanted = [...new Set(newIds)];
  for (const id of wanted)
    if (!known.has(id))
      throw badRequest('unknown_workstation', 'choose workstations of this organization that can hold packs');
  if (pack.visibility === 'private' && wanted.some((id) => known.get(id)?.user_id !== pack.owner_user_id))
    throw badRequest('private_pack_own_workstation', 'a private pack lives on its owner’s workstation only');
  const current = ((pack.workstation_ids as string[] | null) ?? []) as string[];
  const added = wanted.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !wanted.includes(id));
  const kind: PackCredentialKind | null = (credential?.kind ??
    pack.credential_kind) as PackCredentialKind | null;
  const out: HolderChange = { deliver: [], sync: [] };

  // A private repository needs a share for every new holder (and for all of them when the credential is replaced).
  if (kind) {
    const need = credential ? wanted : added;
    const have = new Map((credential?.shares ?? []).map((s) => [s.workstationId, s]));
    for (const id of need)
      if (!have.has(id))
        throw badRequest(
          'credential_share_missing',
          `${known.get(id)?.name ?? 'a workstation'} needs the deploy key or token sealed for it`,
        );
    for (const sh of credential?.shares ?? [])
      if (!wanted.includes(sh.workstationId))
        throw badRequest(
          'credential_share_unknown',
          'a key was sealed for a workstation that does not hold the pack',
        );
    for (const id of need) {
      const w = known.get(id);
      if (!w?.authoring)
        throw badRequest(
          'runner_too_old',
          `update the runner on ${w?.name ?? 'the workstation'} to use private packs and deploy keys`,
        );
      const k = await one(tx, 'SELECT key_id FROM workstation_keys WHERE workstation_id=$1', [id]);
      const sh = have.get(id);
      if (!k || !sh || k.key_id !== sh.keyId)
        throw conflict(
          'sudo_key_changed',
          `the runner key of ${w.name} changed: reload the page and seal the key again`,
        );
    }
  }
  if (!kind) {
    for (const id of added)
      if (pack.source !== 'git' && !known.get(id)?.authoring)
        throw badRequest(
          'runner_too_old',
          `update the runner on ${known.get(id)?.name} to hold authored packs`,
        );
  }

  const events: AppendInput[] = [];
  if (removed.length || added.length || current.join() !== wanted.join())
    events.push(
      packEvent(
        'PackWorkstationsChanged',
        { packId: pack.id, orgId: pack.org_id, workstationIds: wanted, changedBy: by.userId },
        pack,
        by.userId,
      ),
    );
  // opt-in: a workstation of another member than the admin who added the pack
  const pending = new Set<string>();
  for (const id of added) {
    const w = known.get(id);
    if (!w) continue;
    // the admin's own workstations (the one who added the pack, or the one changing the holders) need no opt-in
    if (w.user_id === pack.added_by || w.user_id === by.userId) continue;
    const deskItemId = randomUUID();
    pending.add(id);
    events.push(
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'approval',
            subkind: PACK_ASSIGNMENT_SUBKIND,
            title: `Allow the pack "${pack.name}" on ${w.name}?`,
            body: assignmentBody(pack, by.name),
            options: [],
            blocking: false,
            pinned: false,
            affectedCardIds: [],
            addresseeUserId: w.user_id,
            askedBy: { kind: 'user', userId: by.userId },
            data: { packId: pack.id, workstationId: id },
            subjectKey: `pack_assignment:${pack.id}:${id}`,
          },
        },
        actor: userActor(by.userId),
        scope: orgScope(pack.org_id),
      } as AppendInput,
      packEvent(
        'PackAssignmentRequested',
        {
          packId: pack.id,
          orgId: pack.org_id,
          workstationId: id,
          userId: w.user_id,
          deskItemId,
          requestedBy: by.userId,
        },
        pack,
        by.userId,
      ),
    );
  }
  // holders that left: their open requests are withdrawn
  for (const id of removed) {
    const a = await one(
      tx,
      `SELECT desk_item_id FROM pack_assignments WHERE pack_id=$1 AND workstation_id=$2 AND status='pending'`,
      [pack.id, id],
    );
    if (a?.desk_item_id)
      events.push({
        streamId: streamId.desk(a.desk_item_id),
        event: {
          type: 'DeskItemResolved',
          payload: {
            deskItemId: a.desk_item_id,
            resolution: 'dismissed',
            note: 'The pack was taken off this workstation.',
            by: { kind: 'system' },
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(pack.org_id),
      } as AppendInput);
  }
  if (kind && credential)
    events.push(
      packEvent(
        'PackCredentialSet',
        {
          packId: pack.id,
          orgId: pack.org_id,
          kind,
          workstationIds: wanted,
          fingerprint: null,
          setBy: by.userId,
        },
        pack,
        by.userId,
      ),
    );
  if (events.length) await ctx.store.append(events, { tx });

  // shares: held for a member who has not accepted, queued for everyone else
  if (kind && credential) {
    for (const sh of credential.shares) {
      await exec(
        tx,
        `INSERT INTO pack_credential_shares (pack_id, workstation_id, key_id, ciphertext, username, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,'held',$6)
         ON CONFLICT (pack_id, workstation_id) DO UPDATE SET key_id=EXCLUDED.key_id, ciphertext=EXCLUDED.ciphertext,
           username=EXCLUDED.username, status='held', error=NULL, updated_at=EXCLUDED.updated_at`,
        [pack.id, sh.workstationId, sh.keyId, sh.ciphertext, credential.username ?? null, ctx.clock.now()],
      );
      if (!pending.has(sh.workstationId) && !(await isPending(tx, pack.id, sh.workstationId))) {
        await queueCredential(ctx, tx, {
          packId: pack.id,
          workstationId: sh.workstationId,
          kind,
          username: credential.username,
        });
        out.deliver.push(sh.workstationId);
      }
    }
  }
  for (const id of removed) {
    await exec(tx, 'DELETE FROM pack_credential_shares WHERE pack_id=$1 AND workstation_id=$2', [
      pack.id,
      id,
    ]);
    await supersedeCredential(tx, id, pack.id);
  }
  out.sync.push(...wanted.filter((id) => !pending.has(id)), ...removed);
  return out;
}

const isPending = async (db: Queryable, packId: string, workstationId: string): Promise<boolean> =>
  !!(await one(
    db,
    `SELECT 1 FROM pack_assignments WHERE pack_id=$1 AND workstation_id=$2 AND status='pending'`,
    [packId, workstationId],
  ));

function assignmentBody(pack: Pack, adminName?: string): string {
  const from = pack.source === 'authored' ? 'an authored capability pack' : `the git repository ${pack.url}`;
  return [
    `${adminName ?? 'An organization admin'} wants to put the capability pack "${pack.name}" (${from}) on your workstation.`,
    'A pack adds skills, personas and playbooks that agents and sessions on this workstation can load. Nothing is downloaded until you accept.',
    pack.credential_kind
      ? 'The repository is private: the admin sealed a deploy key or token to this workstation. It stays on the workstation and is only used to fetch this pack.'
      : '',
    'You can also decline: the pack is then not placed on this workstation.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ------------------------------------------------------------------------------------------------ opt-in

/** Accepts or declines a pack assigned to one of the user's workstations. Returns the workstation to deliver commands to. */
export async function decideAssignmentIn(
  ctx: Ctx,
  tx: Tx,
  userId: string,
  packId: string,
  workstationId: string,
  accept: boolean,
  /** The desk resolves its own item; the settings page asks this function to. */
  resolveDesk = true,
): Promise<string> {
  const a = await one(
    tx,
    `SELECT pa.*, p.org_id, p.visibility, p.owner_user_id, p.credential_kind, p.id AS pid FROM pack_assignments pa
       JOIN packs p ON p.id = pa.pack_id AND p.removed_at IS NULL
      WHERE pa.pack_id=$1 AND pa.workstation_id=$2 FOR UPDATE OF pa`,
    [packId, workstationId],
  );
  if (!a || a.status !== 'pending') throw notFound('this request is already answered');
  if (a.user_id !== userId) throw forbidden('only the owner of that workstation can answer');
  const events: AppendInput[] = [
    packEvent(
      'PackAssignmentDecided',
      { packId, orgId: a.org_id, workstationId, userId, accepted: accept },
      { id: packId, visibility: a.visibility, org_id: a.org_id, owner_user_id: a.owner_user_id },
      userId,
    ),
  ];
  if (a.desk_item_id && resolveDesk)
    events.push({
      streamId: streamId.desk(a.desk_item_id),
      event: {
        type: 'DeskItemResolved',
        payload: {
          deskItemId: a.desk_item_id,
          resolution: accept ? 'approved' : 'rejected',
          by: { kind: 'user', userId },
        },
      },
      actor: userActor(userId),
      scope: orgScope(a.org_id),
    } as AppendInput);
  await ctx.store.append(events, { tx });
  if (accept && a.credential_kind) {
    const sh = await one(
      tx,
      'SELECT username FROM pack_credential_shares WHERE pack_id=$1 AND workstation_id=$2',
      [packId, workstationId],
    );
    // the credential goes first: the runner has the key when the list that names the pack arrives
    await queueCredential(ctx, tx, {
      packId,
      workstationId,
      kind: a.credential_kind,
      username: sh?.username ?? undefined,
    });
  } else if (!accept) {
    await exec(tx, 'DELETE FROM pack_credential_shares WHERE pack_id=$1 AND workstation_id=$2', [
      packId,
      workstationId,
    ]);
  }
  return workstationId;
}

/** The desk hook: resolving the item answers the request (approved accepts; anything else declines). */
export async function resolvePackAssignmentIn(
  ctx: Ctx,
  tx: Tx,
  user: AuthSession['user'],
  item: Row,
  resolution: string,
): Promise<string | undefined> {
  const data = (item.data ?? {}) as { packId?: string; workstationId?: string };
  if (!data.packId || !data.workstationId) return undefined;
  const a = await one(tx, `SELECT status FROM pack_assignments WHERE pack_id=$1 AND workstation_id=$2`, [
    data.packId,
    data.workstationId,
  ]);
  if (!a || a.status !== 'pending') return undefined;
  const ws = await decideAssignmentIn(
    ctx,
    tx,
    user.id,
    data.packId,
    data.workstationId,
    resolution === 'approved',
    false,
  );
  return ws;
}

/** Called after the transaction of an answer: refresh the workstation's list and deliver. */
export async function afterAssignmentDecision(ctx: Ctx, workstationId: string): Promise<void> {
  const { queuePacksSync } = await import('./packs.ts');
  await queuePacksSync(ctx.pool, workstationId);
  void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
}

/** `POST /api/pack-assignments/decide`: the same answer from the settings page instead of the desk. */
export async function decideAssignment(
  ctx: Ctx,
  userId: string,
  packId: string,
  workstationId: string,
  accept: boolean,
): Promise<void> {
  const { withAppendTx } = await import('../db/tx.ts');
  await withAppendTx(ctx.pool, async (tx) => {
    await decideAssignmentIn(ctx, tx, userId, packId, workstationId, accept);
  });
  await afterAssignmentDecision(ctx, workstationId);
  if (accept) {
    const { relayAuthoredBundles } = await import('./pack-authoring.ts');
    await relayAuthoredBundles(ctx, packId);
  }
}

export async function listMyAssignments(ctx: Ctx, userId: string): Promise<PackAssignmentDto[]> {
  const r = await rows(
    ctx.pool,
    `SELECT pa.pack_id, pa.workstation_id, pa.desk_item_id, pa.requested_at, p.name, p.url, p.ref, p.credential_kind,
            w.name AS ws_name, u.display_name AS by_name
       FROM pack_assignments pa
       JOIN packs p ON p.id = pa.pack_id AND p.removed_at IS NULL
       JOIN workstations w ON w.id = pa.workstation_id
       LEFT JOIN users u ON u.id = pa.requested_by
      WHERE pa.user_id=$1 AND pa.status='pending' AND w.status='active'
        AND EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = p.org_id AND om.user_id = $1 AND om.status='active')
      ORDER BY pa.requested_at`,
    [userId],
  );
  return r.map((x) => ({
    packId: x.pack_id,
    packName: x.name,
    url: x.url,
    ref: x.ref,
    private: !!x.credential_kind,
    workstationId: x.workstation_id,
    workstationName: x.ws_name,
    requestedByName: x.by_name ?? null,
    deskItemId: x.desk_item_id ?? null,
    requestedAt: iso(x.requested_at) as string,
  }));
}

// ------------------------------------------------------------------------------------------------ credential results

/** `command.result` of `pack.credential.set`: forget the ciphertext, remember the fact (and the public fingerprint). */
export async function applyPackCredentialResult(
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
  const parsed = ok ? PackCredentialResultSchema.safeParse(result) : undefined;
  const stored = parsed?.success ? parsed.data.stored : false;
  const error = stored
    ? null
    : ((parsed?.success ? parsed.data.error : undefined) ?? 'the workstation could not store the credential');
  // the ciphertext is emptied whatever the answer was
  await exec(
    ctx.pool,
    `UPDATE pack_credential_shares SET ciphertext=NULL, status=$3, error=$4, updated_at=$5 WHERE pack_id=$1 AND workstation_id=$2`,
    [packId, workstationId, stored ? 'stored' : 'failed', error, ctx.clock.now()],
  );
  const p = await one(ctx.pool, 'SELECT * FROM packs WHERE id=$1 AND removed_at IS NULL', [packId]);
  if (!p) return;
  await ctx.store.append([
    packEvent(
      'PackCredentialStored',
      {
        packId,
        orgId: p.org_id,
        workstationId,
        stored,
        error,
        fingerprint: parsed?.success ? (parsed.data.fingerprint ?? null) : null,
      },
      p,
      { workstationId },
    ),
  ]);
  // the credential is here: the list can now clone the pack
  if (stored) {
    const { queuePacksSync } = await import('./packs.ts');
    await queuePacksSync(ctx.pool, workstationId);
    void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
  }
}

/** A workstation that may hold packs with credentials (used by pickers). */
export async function authoringCapable(db: Queryable, workstationId: string): Promise<boolean> {
  return wsHas(db, workstationId, PACK_AUTHORING_CAPABILITY);
}
