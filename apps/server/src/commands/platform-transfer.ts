import { randomUUID } from 'node:crypto';
import { type OwnershipTransfer, streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { ceoOwnerChangeEvents } from '../ceo/provision.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { securityNoticeMail } from '../mail/security-notices.ts';
import { orgScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { sendQuietly } from './platform-settings.ts';

/**
 * Platform ownership transfer (R17-3). The super admin's support case no longer moves the ownership at once: it becomes a
 * pending transfer in `org_ownership_transfers`. The current Owner approves it through the mailed link (signed in, with
 * step-up) or vetoes it; otherwise it takes effect after 7 days (`ownershipTransferTick`). Never automatically for an
 * organization with deploy targets while its Owner is active: then only the Owner's approval moves it, or a new request
 * made after the Owner was deactivated. The Owner and all Admins are mailed. The Owner's own transfer (password
 * confirmed, `commands/orgs.ts`) is unchanged.
 *
 * `decision`: `approved` (the Owner), `vetoed` (the Owner), `automatic` (7 days passed), `superseded` (a newer request),
 * `expired` (still pending after 30 days),
 * `void` (when it was due, the target was no longer an active Admin or the Owner had changed).
 */

export const TRANSFER_NOTICE_MS = 7 * 86_400_000;
/** A request still pending after this long (deploy targets, an Owner who never answered) stops being approvable. */
export const TRANSFER_EXPIRY_MS = 30 * 86_400_000;

const consentLink = (ctx: Ctx, id: string) => `${ctx.config.publicOrigin}/org-transfer/${id}`;

async function hasDeployTargets(db: Queryable, orgId: string): Promise<boolean> {
  return !!(await one(
    db,
    'SELECT 1 AS x FROM deploy_targets WHERE org_id=$1 AND removed_at IS NULL LIMIT 1',
    [orgId],
  ));
}

/**
 * Whether the request may take effect by itself after the notice: no deploy targets, or it was made after the Owner was
 * deactivated (there is nobody left to approve).
 */
async function automaticAllowed(db: Queryable, t: Row): Promise<boolean> {
  if (!(await hasDeployTargets(db, t.org_id))) return true;
  const owner = await one(
    db,
    `SELECT u.id, u.status FROM organizations o JOIN users u ON u.id = o.owner_user_id WHERE o.id=$1`,
    [t.org_id],
  );
  if (owner?.status !== 'deactivated') return false;
  const off = await one(
    db,
    `SELECT max(created_at) AS at FROM events WHERE type='UserDeactivated' AND payload->>'userId'=$1`,
    [owner.id],
  );
  return !!off?.at && new Date(off.at) < new Date(t.created_at);
}

async function toDto(db: Queryable, t: Row): Promise<OwnershipTransfer> {
  const org = await one(db, 'SELECT name FROM organizations WHERE id=$1', [t.org_id]);
  const to = await one(db, 'SELECT id, display_name, email FROM users WHERE id=$1', [t.to_user_id]);
  return {
    id: t.id,
    orgId: t.org_id,
    orgName: org?.name ?? '',
    toUser: { id: t.to_user_id, displayName: to?.display_name ?? '', email: to?.email ?? '' },
    reason: t.reason ?? null,
    requestedAt: iso(t.created_at) as string,
    effectiveAt: iso(t.effective_at) as string,
    automatic: await automaticAllowed(db, t),
    decision: t.decision ?? null,
    decidedAt: iso(t.decided_at),
  };
}

/** The pending transfer of an organization, for the platform organization detail. */
export async function pendingTransferOf(db: Queryable, orgId: string): Promise<OwnershipTransfer | null> {
  const t = await one(
    db,
    `SELECT * FROM org_ownership_transfers WHERE org_id=$1 AND decision IS NULL ORDER BY created_at DESC LIMIT 1`,
    [orgId],
  );
  return t ? toDto(db, t) : null;
}

async function people(db: Queryable, orgId: string) {
  const owner = await one(
    db,
    `SELECT u.id, u.email, u.display_name, u.status FROM organizations o JOIN users u ON u.id = o.owner_user_id
      WHERE o.id=$1`,
    [orgId],
  );
  const admins = await rows(
    db,
    `SELECT u.id, u.email, u.display_name FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id=$1 AND m.status='active' AND m.role='admin' AND u.status='active' ORDER BY lower(u.display_name)`,
    [orgId],
  );
  return { owner, admins };
}

/**
 * The super admin asks to move the ownership to an existing Admin (a reason is mandatory). Replaces an earlier pending
 * request. Mails the Owner (approve or veto) and every Admin.
 */
export async function requestPlatformTransfer(
  ctx: Ctx,
  admin: AuthSession,
  orgId: string,
  toUserId: string,
  reason: string,
): Promise<OwnershipTransfer> {
  const now = ctx.clock.now();
  const id = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    const o = await one(tx, 'SELECT owner_user_id FROM organizations WHERE id=$1 FOR UPDATE', [orgId]);
    if (!o) throw notFound('organization not found');
    const target = await one(
      tx,
      `SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
      [orgId, toUserId],
    );
    if (target?.role !== 'admin')
      throw conflict('not_an_admin', 'ownership can only move to an existing Admin of the organization');
    await exec(
      tx,
      `UPDATE org_ownership_transfers SET decision='superseded', decided_at=$2 WHERE org_id=$1 AND decision IS NULL`,
      [orgId, now],
    );
    await exec(
      tx,
      `INSERT INTO org_ownership_transfers (id, org_id, to_user_id, requested_by, created_at, effective_at, reason,
                                            from_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        orgId,
        toUserId,
        admin.user.id,
        now,
        new Date(now.getTime() + TRANSFER_NOTICE_MS),
        reason,
        o.owner_user_id,
      ],
    );
  });
  const t = await one(ctx.pool, 'SELECT * FROM org_ownership_transfers WHERE id=$1', [id]);
  const dto = await toDto(ctx.pool, t as Row);
  const { owner, admins } = await people(ctx.pool, orgId);
  const when = new Date(dto.effectiveAt).toUTCString();
  const facts: Array<[string, string]> = [
    ['Organization', dto.orgName],
    ['New Owner', `${dto.toUser.displayName} <${dto.toUser.email}>`],
    ['Reason given', reason],
    [
      'Takes effect',
      dto.automatic ? `${when}, unless the Owner vetoes it` : 'Only when the Owner approves it',
    ],
  ];
  if (owner && owner.status === 'active')
    await sendQuietly(
      ctx,
      securityNoticeMail({
        to: owner.email,
        subject: `Approve or veto: ownership of ${dto.orgName} to ${dto.toUser.displayName}`,
        heading: 'A transfer of your organization is waiting for you',
        paragraphs: [
          `Hello ${owner.display_name},`,
          `The ${dto.orgName} ownership was asked to move to ${dto.toUser.displayName} through Guildwise support. Nothing changes until you approve it${dto.automatic ? `, or until ${when} if you do nothing` : ''}.`,
          'If you did not expect this, veto it: the request did not come from you.',
        ],
        facts,
        cta: { label: 'Approve or veto', url: consentLink(ctx, id) },
        origin: ctx.config.publicOrigin,
      }),
    );
  // A deactivated Owner cannot approve or veto, but the real Owner still hears of it at the old address.
  else if (owner)
    await sendQuietly(
      ctx,
      securityNoticeMail({
        to: owner.email,
        subject: `Ownership transfer requested for ${dto.orgName}`,
        heading: 'A transfer of your organization was requested',
        paragraphs: [
          `Hello ${owner.display_name},`,
          `Your account is deactivated, and Guildwise support asked to move the ownership of ${dto.orgName} to ${dto.toUser.displayName}. If you did not expect this, contact support or the organization's Admins now.`,
        ],
        facts,
        origin: ctx.config.publicOrigin,
      }),
    );
  for (const a of admins)
    await sendQuietly(
      ctx,
      securityNoticeMail({
        to: a.email,
        subject: `Ownership transfer requested for ${dto.orgName}`,
        heading: 'An ownership transfer was requested',
        paragraphs: [
          `Hello ${a.display_name},`,
          `Guildwise support asked to move the ownership of ${dto.orgName} to ${dto.toUser.displayName}. The Owner can approve or veto it.`,
        ],
        facts,
        origin: ctx.config.publicOrigin,
      }),
    );
  return dto;
}

/** The Owner's consent page: only the organization's current Owner sees it (404 for everyone else). */
export async function transferForOwner(ctx: Ctx, s: AuthSession, id: string): Promise<OwnershipTransfer> {
  const t = await one(ctx.pool, 'SELECT * FROM org_ownership_transfers WHERE id=$1', [id]);
  if (!t) throw notFound('transfer not found');
  const o = await one(ctx.pool, 'SELECT owner_user_id FROM organizations WHERE id=$1', [t.org_id]);
  if (o?.owner_user_id !== s.user.id) throw notFound('transfer not found');
  return toDto(ctx.pool, t);
}

/** Appends the transfer itself (the same events as before, with the super admin's reason). */
async function completeIn(ctx: Ctx, tx: Tx, t: Row, actor: AppendInput['actor']): Promise<boolean> {
  const o = await one(tx, 'SELECT owner_user_id FROM organizations WHERE id=$1 FOR UPDATE', [t.org_id]);
  const target = await one(
    tx,
    `SELECT m.role FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id=$1 AND m.user_id=$2 AND m.status='active' AND u.status='active'`,
    [t.org_id, t.to_user_id],
  );
  if (!o || target?.role !== 'admin') return false;
  await ctx.store.append(
    [
      {
        streamId: streamId.org(t.org_id),
        event: {
          type: 'OrgOwnershipTransferred',
          payload: {
            orgId: t.org_id,
            fromUserId: o.owner_user_id,
            toUserId: t.to_user_id,
            ...(t.reason ? { reason: String(t.reason).slice(0, 500) } : {}),
          },
        },
        actor,
        scope: orgScope(t.org_id),
      },
      ...(await ceoOwnerChangeEvents(tx, t.org_id, t.to_user_id)),
    ],
    { tx },
  );
  return true;
}

async function mailOutcome(ctx: Ctx, t: Row, decision: 'approved' | 'vetoed' | 'automatic'): Promise<void> {
  const dto = await toDto(ctx.pool, t);
  const { owner, admins } = await people(ctx.pool, t.org_id);
  const text =
    decision === 'vetoed'
      ? `The Owner vetoed moving the ownership of ${dto.orgName} to ${dto.toUser.displayName}. Nothing changed.`
      : `The ownership of ${dto.orgName} moved to ${dto.toUser.displayName}${decision === 'automatic' ? ' after the 7-day notice' : " with the Owner's approval"}.`;
  const to = [...(owner ? [owner] : []), ...admins];
  for (const p of to)
    await sendQuietly(
      ctx,
      securityNoticeMail({
        to: p.email,
        subject:
          decision === 'vetoed'
            ? `Ownership transfer of ${dto.orgName} vetoed`
            : `${dto.toUser.displayName} is now the Owner of ${dto.orgName}`,
        heading: decision === 'vetoed' ? 'Transfer vetoed' : 'Ownership transferred',
        paragraphs: [`Hello ${p.display_name},`, text],
        origin: ctx.config.publicOrigin,
      }),
    );
}

/** The Owner approves (step-up checked by the route) or vetoes a pending transfer. */
export async function decideTransfer(
  ctx: Ctx,
  s: AuthSession,
  id: string,
  decision: 'approved' | 'vetoed',
): Promise<OwnershipTransfer> {
  const now = ctx.clock.now();
  const t = await withAppendTx(ctx.pool, async (tx) => {
    const t = await one(tx, 'SELECT * FROM org_ownership_transfers WHERE id=$1 FOR UPDATE', [id]);
    if (!t) throw notFound('transfer not found');
    const o = await one(tx, 'SELECT owner_user_id FROM organizations WHERE id=$1', [t.org_id]);
    if (o?.owner_user_id !== s.user.id) throw notFound('transfer not found');
    if (t.decision) throw conflict('transfer_decided', `this transfer is already ${t.decision}`);
    if (new Date(t.created_at).getTime() <= now.getTime() - TRANSFER_EXPIRY_MS)
      throw conflict(
        'transfer_expired',
        'this transfer request is older than 30 days: ask support to request it again',
      );
    if (decision === 'approved' && !(await completeIn(ctx, tx, t, userActor(s.user.id))))
      throw conflict('transfer_void', 'the new Owner is no longer an active Admin of the organization');
    await exec(tx, 'UPDATE org_ownership_transfers SET decision=$2, decided_at=$3 WHERE id=$1', [
      id,
      decision,
      now,
    ]);
    return { ...t, decision, decided_at: now };
  });
  await mailOutcome(ctx, t, decision);
  return toDto(ctx.pool, t);
}

/**
 * Pending transfers whose 7-day notice is over take effect (scheduler, every pass), except where the Owner's approval
 * is required (deploy targets and an active Owner): those stay pending. Returns the transfer ids that took effect.
 */
export async function ownershipTransferTick(ctx: Ctx): Promise<string[]> {
  const now = ctx.clock.now();
  const due = await rows<{ id: string }>(
    ctx.pool,
    `SELECT id FROM org_ownership_transfers WHERE decision IS NULL AND (effective_at <= $1 OR created_at <= $2)
      ORDER BY effective_at LIMIT 50`,
    [now, new Date(now.getTime() - TRANSFER_EXPIRY_MS)],
  );
  const done: string[] = [];
  for (const d of due) {
    const t = await withAppendTx(ctx.pool, async (tx) => {
      const t = await one(
        tx,
        `SELECT * FROM org_ownership_transfers WHERE id=$1 AND decision IS NULL FOR UPDATE SKIP LOCKED`,
        [d.id],
      );
      if (!t) return null;
      const close = (decision: 'void' | 'expired') =>
        exec(tx, 'UPDATE org_ownership_transfers SET decision=$2, decided_at=$3 WHERE id=$1', [
          t.id,
          decision,
          now,
        ]);
      // The request asked one Owner for consent: after an ownership change it is void, never automatic (R17-3).
      const cur = await one(tx, 'SELECT owner_user_id FROM organizations WHERE id=$1', [t.org_id]);
      if (t.from_user_id && cur?.owner_user_id !== t.from_user_id) {
        await close('void');
        return null;
      }
      if (new Date(t.created_at).getTime() <= now.getTime() - TRANSFER_EXPIRY_MS) {
        await close('expired');
        return null;
      }
      if (!(await automaticAllowed(tx, t))) return null;
      const ok = await completeIn(ctx, tx, t, SYSTEM_ACTOR);
      await exec(tx, 'UPDATE org_ownership_transfers SET decision=$2, decided_at=$3 WHERE id=$1', [
        t.id,
        ok ? 'automatic' : 'void',
        now,
      ]);
      return ok ? t : null;
    });
    if (!t) continue;
    done.push(t.id);
    await mailOutcome(ctx, t, 'automatic');
  }
  return done;
}
