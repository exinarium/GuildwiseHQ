import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** "Commit as" of a project (migration 1970). */
export const commitAsProjectors: Record<string, Projector> = {
  ProjectCommitAsSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectCommitAsSet'>).payload;
    await exec(tx, 'UPDATE projects SET commit_as=$2::jsonb WHERE id=$1', [
      p.projectId,
      p.commitAs ? JSON.stringify(p.commitAs) : null,
    ]);
  },
};
