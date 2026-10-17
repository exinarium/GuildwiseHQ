import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** Platform pauses (Lean Team v3): a row per pause, ended by `PlatformPauseEnded`. The dispatcher reads open rows. */
export const platformProjectors: Record<string, Projector> = {
  PlatformPauseStarted: async (tx, e) => {
    const p = (e.event as EventOf<'PlatformPauseStarted'>).payload;
    await exec(
      tx,
      `INSERT INTO platform_pauses (id, project_id, workflow_key, stage_id, workstation_id, reason, source, severity,
                                    bug_signature, bug_card_id, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [
        p.pauseId,
        p.scope.projectId,
        p.scope.workflowKey,
        p.scope.stageId,
        p.scope.workstationId,
        p.reason,
        p.source,
        p.severity,
        p.bugSignature ?? null,
        p.bugCardId ?? null,
        p.by ?? null,
        e.createdAt,
      ],
    );
  },
  PlatformPauseEnded: async (tx, e) => {
    const p = (e.event as EventOf<'PlatformPauseEnded'>).payload;
    await exec(
      tx,
      `UPDATE platform_pauses SET resumed_at=$2, resume_reason=$3, resumed_by=$4 WHERE id=$1 AND resumed_at IS NULL`,
      [p.pauseId, e.createdAt, p.reason, p.by],
    );
  },
};
