import {
  type SetSimulationRequest,
  streamId,
  type WipeSimulationRequest,
  type WipeSimulationResponse,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { assignSimulationBilling } from '../billing/engine.ts';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import { deleteOrgRows } from '../simulation/wipe.ts';
import { orgScope, userActor } from './common.ts';
import type { Meta } from './platform.ts';

const metaOf = (m?: Meta) => (m && (m.ip || m.userAgent) ? { meta: { ...m } } : {});

/** What the operator is told about the backup: the server has no built-in database backup of its own. */
export const WIPE_BACKUP_NOTE =
  'The server has no built-in database backup. Take one (pg_dump) before wiping a simulation organization on a production database.';

/** Turns simulation mode on or off for an organization (audited; an event like any other org setting). */
export async function setOrgSimulation(
  ctx: Ctx,
  admin: AuthSession,
  orgId: string,
  req: SetSimulationRequest,
  meta?: Meta,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const o = await one(tx, 'SELECT * FROM organizations WHERE id=$1 FOR UPDATE', [orgId]);
    if (!o) throw notFound('organization not found');
    const pace = req.pace ?? (o.simulation_pace as 'fast' | 'normal' | 'slow');
    if (Boolean(o.simulation) === req.enabled && pace === o.simulation_pace)
      throw conflict('no_change', `simulation is already ${req.enabled ? 'on' : 'off'}`);
    await ctx.store.append(
      [
        {
          streamId: streamId.org(orgId),
          event: {
            type: 'OrgSimulationSet',
            payload: {
              orgId,
              enabled: req.enabled,
              pace,
              by: admin.user.id,
              ...(req.note ? { note: req.note } : {}),
              ...metaOf(meta),
            },
          },
          actor: userActor(admin.user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    // A simulation organization is never billed: its subscription, card and open invoices go (as for Unlimited).
    if (req.enabled && !o.simulation) await assignSimulationBilling(ctx, tx, admin.user.id, orgId, meta);
  });
  ctx.services.simulation?.reconcile(orgId);
  ctx.services.dispatcher.trigger();
}

/**
 * Every id that identifies the organization's footprint in the event log. Events carry `org_id`, but some of the
 * organization's history has no org scope: the platform's views of it, its invitation, and the per-user events
 * (workstations, addressed items) of accounts that only existed in it.
 */
async function eventFootprint(
  tx: import('../db/tx.ts').Tx,
  orgId: string,
  deletedUserIds: string[],
): Promise<{ projectIds: string[]; invitationStreams: string[]; userStreams: string[] }> {
  const projectIds = (await rows<{ id: string }>(tx, 'SELECT id FROM projects WHERE org_id=$1', [orgId])).map(
    (r) => r.id,
  );
  const invitationStreams = (
    await rows<{ id: string }>(
      tx,
      `SELECT id FROM invitations WHERE org_id=$1 OR accepted_user_id = ANY($2::uuid[])`,
      [orgId, deletedUserIds],
    )
  ).map((r) => streamId.invitation(r.id));
  // The simulated workstation belongs to the organization even when its owner lives on in another one.
  const workstationStreams = (
    await rows<{ id: string }>(tx, 'SELECT id FROM workstations WHERE simulation_org_id=$1', [orgId])
  ).map((r) => streamId.workstation(r.id));
  return {
    projectIds,
    invitationStreams,
    userStreams: [...deletedUserIds.map((u) => streamId.user(u)), ...workstationStreams],
  };
}

/**
 * Wipes a simulation organization completely (super admin only, org must be flagged `simulation`, its name typed back).
 *
 * The event log is append-only everywhere else; this is the one deliberate exception, enforced by the database trigger
 * (migration 1540): events of the organization and of the accounts that existed only in it are deleted, together with
 * every projection and operational row. Accounts whose only membership is this organization are deleted entirely (the
 * email can sign up or be invited again); accounts that also belong elsewhere only lose the membership. One
 * `SimulationOrgWiped` event (no org scope) remains as the permanent platform audit entry.
 */
export async function wipeSimulationOrg(
  ctx: Ctx,
  admin: AuthSession,
  orgId: string,
  req: WipeSimulationRequest,
  meta?: Meta,
): Promise<WipeSimulationResponse> {
  const out = await withAppendTx(ctx.pool, async (tx) => {
    const o = await one(tx, 'SELECT * FROM organizations WHERE id=$1 FOR UPDATE', [orgId]);
    if (!o) throw notFound('organization not found');
    if (!o.simulation)
      throw conflict(
        'not_simulation',
        'only a simulation organization can be wiped: turn simulation on first',
      );
    if (req.confirmName.trim() !== o.name)
      throw conflict('name_mismatch', 'the typed name does not match the organization name');

    const members = await rows<{ id: string; email: string; kind: string }>(
      tx,
      `SELECT DISTINCT u.id, u.email, u.kind FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id=$1`,
      [orgId],
    );
    // Accounts that exist only because of this organization: no other membership (even a removed one is "elsewhere"
    // only when active) and no guest access to a project of another organization.
    const deleted: typeof members = [];
    const kept: typeof members = [];
    for (const m of members) {
      const elsewhere = await one(
        tx,
        `SELECT 1 FROM org_members WHERE user_id=$1 AND org_id <> $2 AND status='active'
         UNION ALL
         SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id
          WHERE pm.user_id=$1 AND p.org_id <> $2 AND pm.status IN ('invited','active') LIMIT 1`,
        [m.id, orgId],
      );
      if (m.kind !== 'user' || elsewhere) kept.push(m);
      else deleted.push(m);
    }
    const deletedIds = deleted.map((u) => u.id);
    const fp = await eventFootprint(tx, orgId, deletedIds);

    // Sessions of the kept users that point at the organization.
    await exec(tx, 'UPDATE auth_sessions SET active_org_id=NULL WHERE active_org_id=$1', [orgId]);
    await exec(tx, 'UPDATE users SET last_org_id=NULL WHERE last_org_id=$1', [orgId]);

    // 1. The event log (the single exception): allowed by the trigger only for this simulation organization.
    await tx.query(
      `SELECT set_config('aom.simulation_wipe', 'on', true), set_config('aom.wipe_org', $1, true)`,
      [orgId],
    );
    const ev = await one<{ events: string; audit: string }>(
      tx,
      `WITH d AS (
         DELETE FROM events
          WHERE org_id = $1::uuid
             OR (project_id IS NOT NULL AND project_id = ANY($2::uuid[]))
             OR stream_id = ANY($3::text[])
             OR (user_id IS NOT NULL AND user_id = ANY($4::uuid[]))
             OR (org_id IS NULL AND actor_id = ANY($4::uuid[]))
             OR payload->>'orgId' = $5
          RETURNING seq),
       a AS (DELETE FROM platform_audit_log WHERE seq IN (SELECT seq FROM d) RETURNING seq)
       SELECT (SELECT count(*) FROM d) AS events, (SELECT count(*) FROM a) AS audit`,
      [orgId, fp.projectIds, [...fp.invitationStreams, ...fp.userStreams], deletedIds, orgId],
    );
    await tx.query(`SELECT set_config('aom.simulation_wipe', 'off', true)`);

    // 2. Every projection and operational row of the organization and of the deleted accounts.
    const counts = await deleteOrgRows(tx, orgId, deletedIds);
    counts.events = Number(ev?.events ?? 0);
    counts.platform_audit_log = (counts.platform_audit_log ?? 0) + Number(ev?.audit ?? 0);

    // 3. The permanent audit entry.
    await ctx.store.append(
      [
        {
          streamId: streamId.org(orgId),
          event: {
            type: 'SimulationOrgWiped',
            payload: {
              orgId,
              orgName: o.name,
              by: admin.user.id,
              memberEmails: members.map((m) => m.email),
              deletedUserEmails: deleted.map((m) => m.email),
              counts,
              backupNote: WIPE_BACKUP_NOTE,
              ...metaOf(meta),
            },
          },
          actor: userActor(admin.user.id),
          scope: { orgId: null, projectId: null, audience: 'admin' },
        },
      ],
      { tx },
    );
    return {
      orgName: o.name as string,
      deleted: deleted.map((u) => u.email),
      deletedIds,
      kept: kept.map((u) => u.email),
      counts,
    };
  });

  // Outside the transaction: the simulated workstation process and its files, and any open browser sessions.
  await ctx.services.simulation
    ?.dispose(orgId)
    .catch((err) => ctx.log.error({ err, orgId }, 'simulation dispose'));
  for (const id of out.deletedIds) ctx.services.browser.closeUser(id);
  return {
    orgName: out.orgName,
    deletedUsers: out.deleted,
    keptUsers: out.kept,
    counts: out.counts,
    backupNote: WIPE_BACKUP_NOTE,
  };
}
