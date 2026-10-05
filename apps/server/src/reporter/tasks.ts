import { randomUUID } from 'node:crypto';
import type { ReporterTaskKind } from '@aom/shared';
import { streamId } from '@aom/shared';
import { orgScope, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Queryable } from '../db/sql.ts';
import { one, rows } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';

const ONLINE_WINDOW_MS = 45_000;

/**
 * Is a BA reachable for this organization right now (active, on a connected workstation whose runtime is available)?
 * Routing only holds items for a BA that can look at them; with none the manager gets them at once.
 */
export async function baAvailable(
  db: Queryable,
  orgId: string,
  projectId: string | null,
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - ONLINE_WINDOW_MS);
  const list = await rows(
    db,
    `SELECT a.runtime, ws.runtimes FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
      WHERE a.org_id = $1 AND a.role_key = 'ba' AND a.status = 'active' AND NOT a.is_devops
        AND ws.status = 'active' AND ws.connected AND ws.last_seen_at > $2
        AND ($3::uuid IS NULL OR a.project_id IS NULL OR a.project_id = $3)`,
    [orgId, since, projectId],
  );
  return list.some((a) =>
    (a.runtimes as Array<{ id: string; available: boolean }>).some((r) => r.id === a.runtime && r.available),
  );
}

/** The project a reporter task is filed under: the given one, else the oldest active project of the organization. */
export async function carrierProject(
  db: Queryable,
  orgId: string,
  projectId: string | null,
): Promise<string | null> {
  if (projectId) return projectId;
  const p = await one<{ id: string }>(
    db,
    `SELECT id FROM projects WHERE org_id=$1 AND status='active' ORDER BY created_at, id LIMIT 1`,
    [orgId],
  );
  return p?.id ?? null;
}

/**
 * Queues a reporter task, or adds to one of the same kind and project that no BA has taken yet (a burst of urgent items
 * is one BA shift, not one per item). Returns the events to append; nothing when there is no project to file it under.
 */
export async function enqueueReporterTask(
  db: Queryable,
  input: {
    orgId: string;
    projectId: string | null;
    kind: ReporterTaskKind;
    signalIds?: string[];
    deskItemIds?: string[];
    localDate?: string;
  },
): Promise<AppendInput[]> {
  const projectId = await carrierProject(db, input.orgId, input.projectId);
  if (!projectId) return [];
  const signalIds = input.signalIds ?? [];
  const deskItemIds = input.deskItemIds ?? [];
  const scope = projectScope(input.orgId, projectId);
  if (input.kind !== 'floor_report') {
    const queued = await one<{ id: string }>(
      db,
      `SELECT id FROM ba_tasks WHERE org_id=$1 AND project_id=$2 AND kind=$3 AND status='queued' AND attempts=0
        ORDER BY created_at LIMIT 1`,
      [input.orgId, projectId, input.kind],
    );
    if (queued)
      return [
        {
          streamId: streamId.baTask(queued.id),
          event: { type: 'BaTaskItemsAdded', payload: { taskId: queued.id, deskItemIds, signalIds } },
          actor: SYSTEM_ACTOR,
          scope,
        },
      ];
  }
  const taskId = randomUUID();
  return [
    {
      streamId: streamId.baTask(taskId),
      event: {
        type: 'BaTaskQueued',
        payload: {
          taskId,
          projectId,
          kind: input.kind,
          signalIds,
          deskItemIds,
          ...(input.localDate ? { localDate: input.localDate } : {}),
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
  ];
}

export { orgScope };
