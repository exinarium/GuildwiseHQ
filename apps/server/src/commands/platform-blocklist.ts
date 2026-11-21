import { randomUUID } from 'node:crypto';
import { type AddPlatformBlockRequest, type BlockKind, type PlatformBlockEntry, streamId } from '@aom/shared';
import { normalizeBlockValue } from '../auth/address-policy.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { iso, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import { notifySuperAdmins } from './platform-notify.ts';

/**
 * The owner's block list (R1): domains (with their subdomains), exact addresses, IPs or CIDR ranges, and allowed
 * domains that skip the hosted screening. `screenAddress` (auth/address-policy.ts) reads it at sign-up, invite, accept,
 * login and reset. Every change is an event on the `platform-security` stream (platform audit, `always`) and a mail to
 * every super admin, sent after the commit.
 */

const ADMIN_SCOPE = { orgId: null, projectId: null, audience: 'admin' } as const;

interface Meta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}
const metaOf = (m: Meta) => ({
  ...(m.ip ? { ip: m.ip } : {}),
  ...(m.userAgent ? { userAgent: m.userAgent.slice(0, 400) } : {}),
});

const KIND_LABEL: Record<BlockKind, string> = {
  domain: 'Blocked domain',
  email: 'Blocked address',
  ip: 'Blocked IP or range',
  allow_domain: 'Allowed domain',
};

export async function listBlocklist(ctx: Ctx): Promise<PlatformBlockEntry[]> {
  const r = await rows(
    ctx.pool,
    `SELECT b.id, b.kind, b.value, b.note, b.created_by, b.created_at, u.display_name
       FROM platform_blocklist b LEFT JOIN users u ON u.id = b.created_by
      ORDER BY b.created_at DESC, b.kind, b.value`,
  );
  return r.map((b) => ({
    id: String(b.id),
    kind: b.kind,
    value: b.value,
    note: b.note ?? '',
    createdBy: b.created_by ? { id: b.created_by, displayName: b.display_name ?? '' } : null,
    createdAt: iso(b.created_at) as string,
  }));
}

async function tell(ctx: Ctx, by: AuthSession, verb: 'added' | 'removed', kind: BlockKind, value: string) {
  await notifySuperAdmins(ctx, {
    subject: `Block list ${verb}: ${value}`,
    heading: `A block-list entry was ${verb}`,
    facts: [
      ['Entry', `${KIND_LABEL[kind]}: ${value}`],
      ['By', `${by.user.displayName} <${by.user.email}>`],
    ],
    path: '/platform/security',
    linkLabel: 'Open the block list',
  });
}

/** Adds an entry (the value normalized; 400 `invalid_block_value`, 409 `block_exists` for a repeat). */
export async function addBlock(
  ctx: Ctx,
  by: AuthSession,
  input: AddPlatformBlockRequest,
  meta: Meta = {},
): Promise<PlatformBlockEntry[]> {
  const value = normalizeBlockValue(input.kind, input.value);
  await withAppendTx(ctx.pool, async (tx) => {
    // one writer at a time, so two adds of the same value cannot both pass the check
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('platform_blocklist'))`);
    if (await one(tx, 'SELECT 1 FROM platform_blocklist WHERE kind=$1 AND value=$2', [input.kind, value]))
      throw conflict('block_exists', 'this entry is already on the list');
    await ctx.store.append(
      [
        {
          streamId: streamId.platformSecurity(),
          event: {
            type: 'PlatformBlockAdded',
            payload: {
              blockId: randomUUID(),
              kind: input.kind,
              value,
              note: input.note ?? '',
              by: by.user.id,
              meta: metaOf(meta),
            },
          },
          actor: { kind: 'user', id: by.user.id },
          scope: ADMIN_SCOPE,
        },
      ],
      { tx },
    );
  });
  await tell(ctx, by, 'added', input.kind, value);
  return listBlocklist(ctx);
}

/** Removes an entry by id (404 when it is not on the list). */
export async function removeBlock(
  ctx: Ctx,
  by: AuthSession,
  id: string,
  meta: Meta = {},
): Promise<PlatformBlockEntry[]> {
  const removed = await withAppendTx(ctx.pool, async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('platform_blocklist'))`);
    const b = await one<{ kind: BlockKind; value: string }>(
      tx,
      'SELECT kind, value FROM platform_blocklist WHERE id=$1',
      [id],
    );
    if (!b) throw notFound('block-list entry not found');
    await ctx.store.append(
      [
        {
          streamId: streamId.platformSecurity(),
          event: {
            type: 'PlatformBlockRemoved',
            payload: { blockId: id, kind: b.kind, value: b.value, by: by.user.id, meta: metaOf(meta) },
          },
          actor: { kind: 'user', id: by.user.id },
          scope: ADMIN_SCOPE,
        },
      ],
      { tx },
    );
    return b;
  });
  await tell(ctx, by, 'removed', removed.kind, removed.value);
  return listBlocklist(ctx);
}
