import { randomUUID } from 'node:crypto';
import {
  GRANT_DEFAULT_HOURS,
  GRANT_MAX_HOURS,
  PLATFORM_DESK_SUBKIND,
  type PlatformGrantDto,
  type RequestGrantRequest,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { orgScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { notifyPlatformDesk } from './desk.ts';

/**
 * Grants of more diagnostics (Lean Team v3, owner decision): a bug that hit a client organisation carries only the
 * sanitised diagnostics. The platform team can ask the client organisation for more of ONE bug; the organisation's
 * Owner or Admin approves on its desk. A grant is time-boxed (default 24 h, at most 72 h), every read under it is
 * audited, and the client organisation can revoke it at any time.
 */

const dto = (r: Row): PlatformGrantDto => ({
  id: r.id,
  signature: r.signature,
  bugCardId: r.bug_card_id,
  clientOrgId: r.client_org_id,
  clientOrgName: r.client_org_name ?? null,
  status: r.status,
  reason: r.reason,
  hours: r.hours,
  requestedAt: iso(r.requested_at) as string,
  decidedAt: iso(r.decided_at),
  expiresAt: iso(r.expires_at),
  revokedAt: iso(r.revoked_at),
});

const SELECT = `SELECT g.*, o.name AS client_org_name FROM platform_diag_grants g
                  LEFT JOIN organizations o ON o.id = g.client_org_id`;

export async function requestGrant(
  ctx: Ctx,
  user: AuthSession['user'],
  req: RequestGrantRequest,
): Promise<PlatformGrantDto> {
  const hours = Math.min(req.hours ?? GRANT_DEFAULT_HOURS, GRANT_MAX_HOURS);
  const id = await withAppendTx(ctx.pool, async (tx) => {
    const bug = await one(tx, 'SELECT * FROM platform_bugs WHERE signature=$1', [req.signature]);
    if (!bug) throw notFound('bug not found');
    if (!bug.client_org_id)
      throw badRequest('internal_bug', 'this bug did not hit a client organization: no grant is needed');
    const open = await one(
      tx,
      `SELECT id FROM platform_diag_grants WHERE signature=$1 AND client_org_id=$2
          AND (status='requested' OR (status='approved' AND expires_at > $3))`,
      [req.signature, bug.client_org_id, ctx.clock.now()],
    );
    if (open) throw conflict('grant_open', 'a request or grant for this bug is already open');
    const grantId = randomUUID();
    const deskItemId = randomUUID();
    const now = ctx.clock.now();
    await tx.query(
      `INSERT INTO platform_diag_grants (id, signature, bug_card_id, client_org_id, requested_by, reason, hours, desk_item_id, requested_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [grantId, req.signature, bug.card_id, bug.client_org_id, user.id, req.reason, hours, deskItemId, now],
    );
    await ctx.store.append(
      [
        {
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'approval',
              subkind: PLATFORM_DESK_SUBKIND.grantRequest,
              title: `The Guildwise platform team asks to see more of a bug that hit your organization`,
              body: `Bug: ${bug.title}\n\nReason: ${req.reason}\n\nBy default the platform team sees only sanitised diagnostics (error signature, function names, counts and versions): no paths, secrets, card content or user data. Approving lets the team read extra detail of THIS bug (the affected card reference and stage) for ${hours} hours. Every read is logged, and you can revoke the grant at any time.`,
              options: [],
              blocking: false,
              pinned: false,
              affectedCardIds: [],
              askedBy: { kind: 'system' },
              data: { grantId, signature: req.signature },
              subjectKey: `platform_grant:${req.signature}`,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(bug.client_org_id),
        },
      ],
      { tx },
    );
    return grantId;
  });
  await notifyPlatformDesk(ctx, {
    subjectKey: `platform_grant_asked:${id}`,
    subkind: PLATFORM_DESK_SUBKIND.grantRequest,
    title: `Asked a client organization for more diagnostics`,
    body: `Waiting for the organization's Owner or Admin to approve (${hours} hours if granted).`,
    data: { grantId: id },
  });
  return (await grantById(ctx, id)) as PlatformGrantDto;
}

export async function grantById(ctx: Ctx, id: string): Promise<PlatformGrantDto | null> {
  const r = await one(ctx.pool, `${SELECT} WHERE g.id=$1`, [id]);
  return r ? dto(r) : null;
}

export async function listGrants(ctx: Ctx, opts: { orgId?: string } = {}): Promise<PlatformGrantDto[]> {
  const list = await rows(
    ctx.pool,
    `${SELECT} WHERE ($1::uuid IS NULL OR g.client_org_id = $1) ORDER BY g.requested_at DESC LIMIT 200`,
    [opts.orgId ?? null],
  );
  return list.map(dto);
}

/** The client organisation's desk decision (desk `closeItem` hook). */
export async function resolveGrantIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  item: Row,
  resolution: 'approved' | 'rejected' | 'acknowledged' | 'dismissed',
): Promise<void> {
  const g = await one(tx, `SELECT * FROM platform_diag_grants WHERE desk_item_id=$1 FOR UPDATE`, [item.id]);
  if (!g || g.status !== 'requested') return;
  if (resolution === 'acknowledged')
    throw badRequest('wrong_resolution', 'a grant request is approved or rejected');
  const now = ctx.clock.now();
  const approved = resolution === 'approved';
  await tx.query(
    `UPDATE platform_diag_grants SET status=$2, decided_at=$3, decided_by=$4, expires_at=$5 WHERE id=$1`,
    [
      g.id,
      approved ? 'approved' : 'denied',
      now,
      user.id,
      approved ? new Date(now.getTime() + g.hours * 3_600_000) : null,
    ],
  );
  await notifyPlatformDesk(
    ctx,
    {
      subjectKey: `platform_grant_decided:${g.id}`,
      subkind: PLATFORM_DESK_SUBKIND.grantRequest,
      title: approved
        ? 'A client organization granted more diagnostics'
        : 'A client organization declined more diagnostics',
      body: approved
        ? `Granted for ${g.hours} hours. Read the extra detail on the platform page; every read is logged.`
        : 'The organization declined. Work from the sanitised diagnostics.',
      data: { grantId: g.id },
    },
    { tx },
  );
}

/** The client organisation (its Owner or Admin) withdraws a grant. */
export async function revokeGrant(
  ctx: Ctx,
  user: AuthSession['user'],
  grantId: string,
): Promise<PlatformGrantDto> {
  await withAppendTx(ctx.pool, async (tx) => {
    const g = await one(tx, 'SELECT * FROM platform_diag_grants WHERE id=$1 FOR UPDATE', [grantId]);
    if (!g) throw notFound('grant not found');
    const m = await one(
      tx,
      `SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
      [g.client_org_id, user.id],
    );
    if (m?.role !== 'owner' && m?.role !== 'admin')
      throw forbidden('only the Owner or an Admin of the organization can revoke this grant');
    if (g.status !== 'approved' && g.status !== 'requested')
      throw conflict('not_active', `this grant is already ${g.status}`);
    await tx.query(
      `UPDATE platform_diag_grants SET status='revoked', revoked_at=$2, revoked_by=$3 WHERE id=$1`,
      [grantId, ctx.clock.now(), user.id],
    );
    // A request still open on the desk closes with it.
    if (g.status === 'requested' && g.desk_item_id)
      await ctx.store.append(
        [
          {
            streamId: streamId.desk(g.desk_item_id),
            event: {
              type: 'DeskItemResolved',
              payload: {
                deskItemId: g.desk_item_id,
                resolution: 'dismissed',
                note: 'Withdrawn by the organization.',
                by: { kind: 'user', userId: user.id },
              },
            },
            actor: userActor(user.id),
            scope: orgScope(g.client_org_id),
          },
        ],
        { tx },
      );
    await notifyPlatformDesk(
      ctx,
      {
        subjectKey: `platform_grant_revoked:${grantId}`,
        subkind: PLATFORM_DESK_SUBKIND.grantRequest,
        title: 'A client organization revoked the grant of extra diagnostics',
        body: 'Access to the extra detail ended at once.',
        data: { grantId },
      },
      { tx },
    );
  });
  return (await grantById(ctx, grantId)) as PlatformGrantDto;
}

/** Ends approved grants whose time is up. Returns how many expired. */
export async function expireGrants(ctx: Ctx): Promise<number> {
  const r = await ctx.pool.query(
    `UPDATE platform_diag_grants SET status='expired' WHERE status='approved' AND expires_at <= $1 RETURNING id`,
    [ctx.clock.now()],
  );
  return r.rowCount ?? 0;
}

/**
 * The extra detail of a bug, only under an approved, unexpired, unrevoked grant. Every read is logged against the grant.
 */
export async function readExtendedDiagnostics(
  ctx: Ctx,
  user: AuthSession['user'],
  signature: string,
): Promise<{ grantId: string; expiresAt: string; extended: Record<string, unknown> }> {
  return withAppendTx(ctx.pool, async (tx) => {
    const g = await one(
      tx,
      `SELECT g.id, g.expires_at, b.extended FROM platform_diag_grants g JOIN platform_bugs b ON b.signature = g.signature
        WHERE g.signature=$1 AND g.status='approved' AND g.expires_at > $2 ORDER BY g.expires_at DESC LIMIT 1`,
      [signature, ctx.clock.now()],
    );
    if (!g) throw forbidden('no active grant for this bug: ask the organization for one');
    await tx.query('INSERT INTO platform_diag_access (grant_id, user_id, at) VALUES ($1,$2,$3)', [
      g.id,
      user.id,
      ctx.clock.now(),
    ]);
    return { grantId: g.id, expiresAt: iso(g.expires_at) as string, extended: g.extended };
  });
}

export async function grantAccessLog(
  ctx: Ctx,
  grantId: string,
): Promise<Array<{ userId: string; at: string }>> {
  const list = await rows(
    ctx.pool,
    'SELECT user_id, at FROM platform_diag_access WHERE grant_id=$1 ORDER BY at',
    [grantId],
  );
  return list.map((r) => ({ userId: r.user_id, at: iso(r.at) as string }));
}
