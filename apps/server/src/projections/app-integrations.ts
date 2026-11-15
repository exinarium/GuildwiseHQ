import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

type AppEvent =
  | 'OrgAppIntegrationAdded'
  | 'OrgAppIntegrationUpdated'
  | 'OrgAppIntegrationShared'
  | 'OrgAppIntegrationUnshared'
  | 'OrgAppIntegrationRemoved';
const ev = <T extends AppEvent>(e: StoredEvent) => e.event as EventOf<T>;

/** Automated app integrations: identity facts and which workstations hold the key. Never a key, token or envelope. */
export const appIntegrationProjectors: Record<string, Projector> = {
  OrgAppIntegrationAdded: async (tx, e) => {
    const p = ev<'OrgAppIntegrationAdded'>(e).payload;
    await exec(
      tx,
      `INSERT INTO org_app_integrations (id, org_id, provider, label, host, app_id, app_slug, app_name, installation_id, account,
         account_type, repository_selection, bot_login, bot_user_id, commit_name, commit_email, permissions, missing_permissions,
         status, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'active',$19,$20,$20)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.integrationId,
        p.orgId,
        p.provider,
        p.label,
        p.host,
        p.appId,
        p.appSlug,
        p.appName,
        p.installationId,
        p.account,
        p.accountType ?? null,
        p.repositorySelection ?? null,
        p.botLogin,
        p.botUserId,
        p.commitName,
        p.commitEmail,
        JSON.stringify(p.permissions),
        JSON.stringify(p.missingPermissions),
        p.by,
        e.createdAt,
      ],
    );
  },
  OrgAppIntegrationUpdated: async (tx, e) => {
    const p = ev<'OrgAppIntegrationUpdated'>(e).payload;
    if (p.label)
      await exec(tx, `UPDATE org_app_integrations SET label=$2, updated_at=$3 WHERE id=$1`, [
        p.integrationId,
        p.label,
        e.createdAt,
      ]);
    if (p.identity)
      await exec(
        tx,
        `UPDATE org_app_integrations SET app_slug=$2, app_name=$3, account=$4, bot_login=$5, bot_user_id=$6, commit_name=$7,
           commit_email=$8, permissions=$9, missing_permissions=$10, updated_at=$11 WHERE id=$1`,
        [
          p.integrationId,
          p.identity.appSlug,
          p.identity.appName,
          p.identity.account,
          p.identity.botLogin,
          p.identity.botUserId,
          p.identity.commitName,
          p.identity.commitEmail,
          JSON.stringify(p.identity.permissions),
          JSON.stringify(p.identity.missingPermissions),
          e.createdAt,
        ],
      );
  },
  OrgAppIntegrationShared: async (tx, e) => {
    const p = ev<'OrgAppIntegrationShared'>(e).payload;
    await exec(
      tx,
      `INSERT INTO org_app_integration_workstations (integration_id, workstation_id, via, added_by, added_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (integration_id, workstation_id) DO NOTHING`,
      [p.integrationId, p.workstationId, p.via, p.by, e.createdAt],
    );
  },
  OrgAppIntegrationUnshared: async (tx, e) => {
    const p = ev<'OrgAppIntegrationUnshared'>(e).payload;
    await exec(
      tx,
      `DELETE FROM org_app_integration_workstations WHERE integration_id=$1 AND workstation_id=$2`,
      [p.integrationId, p.workstationId],
    );
  },
  OrgAppIntegrationRemoved: async (tx, e) => {
    const p = ev<'OrgAppIntegrationRemoved'>(e).payload;
    await exec(
      tx,
      `UPDATE org_app_integrations SET status='removed', removed_at=$2, updated_at=$2 WHERE id=$1`,
      [p.integrationId, e.createdAt],
    );
    await exec(tx, `DELETE FROM org_app_integration_workstations WHERE integration_id=$1`, [p.integrationId]);
  },
};
