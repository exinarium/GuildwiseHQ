import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

export const industryBundleProjectors: Record<string, Projector> = {
  IndustryBundleInstalled: async (tx, e) => {
    const p = (e.event as EventOf<'IndustryBundleInstalled'>).payload;
    await exec(
      tx,
      `INSERT INTO org_industry_bundles (org_id, bundle_id, bundle_version, items, installed_at, installed_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT (org_id, bundle_id) DO UPDATE
         SET bundle_version=EXCLUDED.bundle_version, items=EXCLUDED.items, installed_at=EXCLUDED.installed_at,
             installed_by=EXCLUDED.installed_by, removed_at=NULL, removed_by=NULL`,
      [
        e.scope.orgId,
        p.bundleId,
        p.bundleVersion,
        JSON.stringify(p.items),
        e.createdAt,
        e.actor.kind === 'user' ? e.actor.id : null,
      ],
    );
  },
  IndustryBundleRemoved: async (tx, e) => {
    const p = (e.event as EventOf<'IndustryBundleRemoved'>).payload;
    await exec(
      tx,
      'UPDATE org_industry_bundles SET removed_at=$3, removed_by=$4 WHERE org_id=$1 AND bundle_id=$2',
      [e.scope.orgId, p.bundleId, e.createdAt, e.actor.kind === 'user' ? e.actor.id : null],
    );
  },
};
