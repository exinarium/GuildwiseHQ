import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

const insertUser = (
  tx: Parameters<Projector>[0],
  u: { userId: string; email: string; displayName: string; passwordHash: string; role?: string },
  at: Date,
  kind: 'user' | 'super_admin' = 'user',
) =>
  exec(
    tx,
    `INSERT INTO users (id, email, display_name, password_hash, legacy_role, kind, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'active',$7)`,
    [u.userId, u.email, u.displayName, u.passwordHash, u.role ?? null, kind, at],
  );

export const userProjectors: Record<string, Projector> = {
  UserTourStateChanged: async (tx, e) => {
    const p = (e.event as EventOf<'UserTourStateChanged'>).payload;
    await exec(tx, 'UPDATE users SET tour_status=$2, tour_step=$3 WHERE id=$1', [p.userId, p.status, p.step]);
  },
  UserAvatarSet: async (tx, e) => {
    const p = (e.event as EventOf<'UserAvatarSet'>).payload;
    await exec(
      tx,
      `UPDATE users SET avatar_kind=$2, avatar_seed=$3, avatar_style=$4, avatar_image_id=$5 WHERE id=$1`,
      [
        p.userId,
        p.kind === 'none' ? null : p.kind,
        p.kind === 'cartoon' ? (p.seed ?? null) : null,
        p.kind === 'cartoon' ? (p.style ?? 'notionists') : null,
        p.kind === 'image' ? (p.imageId ?? null) : null,
      ],
    );
  },
  UserBootstrapped: async (tx, e) => {
    const p = (e.event as EventOf<'UserBootstrapped'>).payload;
    await insertUser(tx, p, e.createdAt);
  },
  UserInvited: async (tx, e) => {
    const p = (e.event as EventOf<'UserInvited'>).payload;
    await exec(
      tx,
      `INSERT INTO invitations (id, email, role, token_hash, invited_by, status, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)`,
      [p.invitationId, p.email, p.role, p.tokenHash, p.invitedBy, p.expiresAt, e.createdAt],
    );
  },
  InvitationResent: async (tx, e) => {
    const p = (e.event as EventOf<'InvitationResent'>).payload;
    await exec(tx, 'UPDATE invitations SET token_hash=$2, expires_at=$3 WHERE id=$1', [
      p.invitationId,
      p.tokenHash,
      p.expiresAt,
    ]);
  },
  InvitationRevoked: async (tx, e) => {
    const p = (e.event as EventOf<'InvitationRevoked'>).payload;
    await exec(tx, `UPDATE invitations SET status='revoked' WHERE id=$1`, [p.invitationId]);
  },
  /** An account created by accepting a new-organization or organization-member invitation. */
  UserRegistered: async (tx, e) => {
    const p = (e.event as EventOf<'UserRegistered'>).payload;
    await insertUser(tx, p, e.createdAt);
  },
  SuperAdminCreated: async (tx, e) => {
    const p = (e.event as EventOf<'SuperAdminCreated'>).payload;
    await insertUser(tx, p, e.createdAt, 'super_admin');
  },
  OrgInvitationCreated: async (tx, e) => {
    const p = (e.event as EventOf<'OrgInvitationCreated'>).payload;
    await exec(
      tx,
      `INSERT INTO invitations (id, email, role, token_hash, invited_by, status, expires_at, created_at, kind, org_id,
         org_role, proposed_org_name, org_terms, project_ids)
       VALUES ($1,$2,NULL,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        p.invitationId,
        p.email,
        p.tokenHash,
        p.invitedBy,
        p.expiresAt,
        e.createdAt,
        p.kind,
        p.orgId ?? null,
        p.orgRole,
        p.proposedOrgName ?? null,
        p.orgTerms ? JSON.stringify(p.orgTerms) : null,
        p.projectIds,
      ],
    );
  },
  OrgInvitationAccepted: async (tx, e) => {
    const p = (e.event as EventOf<'OrgInvitationAccepted'>).payload;
    await exec(
      tx,
      `UPDATE invitations SET status='accepted', accepted_at=$2, accepted_user_id=$3 WHERE id=$1`,
      [p.invitationId, e.createdAt, p.userId],
    );
  },
  TwoFactorEnabled: async (tx, e) => {
    const p = (e.event as EventOf<'TwoFactorEnabled'>).payload;
    await exec(tx, 'UPDATE users SET two_factor_enabled=true WHERE id=$1', [p.userId]);
  },
  TwoFactorDisabled: async (tx, e) => {
    const p = (e.event as EventOf<'TwoFactorDisabled'>).payload;
    await exec(tx, 'UPDATE users SET two_factor_enabled=false WHERE id=$1', [p.userId]);
  },
  InvitationAccepted: async (tx, e) => {
    const p = (e.event as EventOf<'InvitationAccepted'>).payload;
    await insertUser(tx, p, e.createdAt);
    await exec(
      tx,
      `UPDATE invitations SET status='accepted', accepted_at=$2, accepted_user_id=$3 WHERE id=$1`,
      [p.invitationId, e.createdAt, p.userId],
    );
  },
  UserRoleChanged: async (tx, e) => {
    const p = (e.event as EventOf<'UserRoleChanged'>).payload;
    await exec(tx, 'UPDATE users SET legacy_role=$2 WHERE id=$1', [p.userId, p.role]);
  },
  UserDeactivated: async (tx, e) => {
    const p = (e.event as EventOf<'UserDeactivated'>).payload;
    await exec(tx, `UPDATE users SET status='deactivated', deactivated_at=$2 WHERE id=$1`, [
      p.userId,
      e.createdAt,
    ]);
    // Their own agents stop with them: parked until the account is back (or the owner re-homes them). Agents of
    // shared projects were already handed to the project owners by the member removals that precede this event.
    await exec(
      tx,
      `UPDATE agents SET status='needs_rehome', workstation_id=NULL
        WHERE manager_user_id=$1 AND status='active' AND NOT is_devops`,
      [p.userId],
    );
  },
  UserReactivated: async (tx, e) => {
    const p = (e.event as EventOf<'UserReactivated'>).payload;
    await exec(tx, `UPDATE users SET status='active', deactivated_at=NULL WHERE id=$1`, [p.userId]);
  },
  PasswordChanged: async (tx, e) => {
    const p = (e.event as EventOf<'PasswordChanged'>).payload;
    await exec(tx, 'UPDATE users SET password_hash=$2 WHERE id=$1', [p.userId, p.passwordHash]);
  },
};
