import { randomUUID } from 'node:crypto';
import { streamId, type UserRole } from '@aom/shared';
import { hashPassword } from '../auth/password.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import { invitationMail } from '../mail/templates.ts';

const INVITE_TTL_MS = 7 * 24 * 3600_000;
const ADMIN_SCOPE = { orgId: null, projectId: null, audience: 'admin' } as const;

export const invitationLink = (ctx: Ctx, token: string) => `${ctx.config.publicOrigin}/invite/${token}`;

async function sendInvitationMail(ctx: Ctx, to: string, token: string, invitedBy: string, expiresAt: Date) {
  try {
    await ctx.mailer.send(invitationMail({ to, link: invitationLink(ctx, token), invitedBy, expiresAt }));
  } catch (err) {
    // The invitation exists; the admin can resend once mail is healthy.
    ctx.log.error({ err, to }, 'failed to send invitation mail');
  }
}

export async function inviteUser(ctx: Ctx, admin: AuthSession, input: { email: string; role: UserRole }) {
  const token = randomToken(32);
  const invitationId = randomUUID();
  const expiresAt = new Date(ctx.clock.now().getTime() + INVITE_TTL_MS);
  await withAppendTx(ctx.pool, async (tx) => {
    if (await one(tx, 'SELECT 1 FROM users WHERE lower(email)=lower($1)', [input.email])) {
      throw conflict('user_exists', 'a user with this email already exists');
    }
    if (
      await one(tx, `SELECT 1 FROM invitations WHERE lower(email)=lower($1) AND status='pending'`, [
        input.email,
      ])
    ) {
      throw conflict('invitation_pending', 'a pending invitation for this email exists; resend or revoke it');
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.invitation(invitationId),
          event: {
            type: 'UserInvited',
            payload: {
              invitationId,
              email: input.email,
              role: input.role,
              tokenHash: sha256Hex(token),
              expiresAt: expiresAt.toISOString(),
              invitedBy: admin.user.id,
            },
          },
          actor: { kind: 'user', id: admin.user.id },
          scope: ADMIN_SCOPE,
        },
      ],
      { tx },
    );
  });
  await sendInvitationMail(ctx, input.email, token, admin.user.displayName, expiresAt);
  return invitationId;
}

export async function resendInvitation(ctx: Ctx, admin: AuthSession, invitationId: string) {
  const token = randomToken(32);
  const expiresAt = new Date(ctx.clock.now().getTime() + INVITE_TTL_MS);
  const email = await withAppendTx(ctx.pool, async (tx) => {
    const inv = await one(tx, 'SELECT email, status FROM invitations WHERE id=$1 FOR UPDATE', [invitationId]);
    if (!inv) throw notFound('invitation not found');
    if (inv.status !== 'pending') throw conflict('invitation_not_pending', `invitation is ${inv.status}`);
    await ctx.store.append(
      [
        {
          streamId: streamId.invitation(invitationId),
          event: {
            type: 'InvitationResent',
            payload: { invitationId, tokenHash: sha256Hex(token), expiresAt: expiresAt.toISOString() },
          },
          actor: { kind: 'user', id: admin.user.id },
          scope: ADMIN_SCOPE,
        },
      ],
      { tx },
    );
    return inv.email as string;
  });
  await sendInvitationMail(ctx, email, token, admin.user.displayName, expiresAt);
}

export async function revokeInvitation(ctx: Ctx, admin: AuthSession, invitationId: string) {
  await withAppendTx(ctx.pool, async (tx) => {
    const inv = await one(tx, 'SELECT status FROM invitations WHERE id=$1 FOR UPDATE', [invitationId]);
    if (!inv) throw notFound('invitation not found');
    if (inv.status !== 'pending') throw conflict('invitation_not_pending', `invitation is ${inv.status}`);
    await ctx.store.append(
      [
        {
          streamId: streamId.invitation(invitationId),
          event: { type: 'InvitationRevoked', payload: { invitationId } },
          actor: { kind: 'user', id: admin.user.id },
          scope: ADMIN_SCOPE,
        },
      ],
      { tx },
    );
  });
}

/** Valid = pending and not expired (clock-aware). */
export async function lookupInvitation(ctx: Ctx, token: string) {
  const inv = await one(
    ctx.pool,
    `SELECT id, email, role, expires_at FROM invitations WHERE token_hash=$1 AND status='pending' AND expires_at > $2`,
    [sha256Hex(token), ctx.clock.now()],
  );
  if (!inv) throw notFound('invitation is invalid or expired');
  return inv as { id: string; email: string; role: UserRole; expires_at: Date };
}

export async function acceptInvitation(
  ctx: Ctx,
  token: string,
  input: { displayName: string; password: string },
): Promise<string> {
  const passwordHash = await hashPassword(input.password);
  const userId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    // Single use: the status flip happens in this transaction, guarded by the row lock.
    const inv = await one(
      tx,
      `SELECT id, email, role FROM invitations
        WHERE token_hash=$1 AND status='pending' AND expires_at > $2 FOR UPDATE`,
      [sha256Hex(token), ctx.clock.now()],
    );
    if (!inv) throw notFound('invitation is invalid or expired');
    if (await one(tx, 'SELECT 1 FROM users WHERE lower(email)=lower($1)', [inv.email])) {
      throw conflict('user_exists', 'a user with this email already exists');
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.user(userId),
          event: {
            type: 'InvitationAccepted',
            payload: {
              invitationId: inv.id,
              userId,
              email: inv.email,
              displayName: input.displayName,
              passwordHash,
              role: inv.role,
            },
          },
          actor: { kind: 'user', id: userId },
          scope: ADMIN_SCOPE,
        },
      ],
      { tx },
    );
  });
  return userId;
}

export async function listInvitations(ctx: Ctx) {
  return rows(ctx.pool, 'SELECT * FROM invitations ORDER BY created_at DESC');
}
