import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/**
 * "Post as" apps of a project (migration 2980). Nothing here listens to OrgAppIntegrationRemoved: the removed state is
 * read live from org_app_integrations.status, so the reference stays and the project falls back visibly.
 */
export const postAsProjectors: Record<string, Projector> = {
  ProjectPostAsAppsSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectPostAsAppsSet'>).payload;
    await exec(tx, 'UPDATE projects SET post_as=$2::jsonb, post_as_set_by=$3, post_as_set_at=$4 WHERE id=$1', [
      p.projectId,
      p.apps.length ? JSON.stringify(p.apps) : null,
      p.setBy,
      e.createdAt,
    ]);
  },
};
