import { type EventViewer, eventAccess, type OrgRole, type VisibleEvent } from '@aom/shared';
import { EVENT_VISIBILITY_SQL, visibleProjectIds } from '../authz/scope.ts';
import { type Queryable, rows } from '../db/sql.ts';
import { rowToEvent } from '../eventstore/pg-event-store.ts';
import type { StoredEvent } from '../eventstore/types.ts';

const SECRET_KEYS = new Set(['passwordHash', 'tokenHash']);

/** Payload as shown to browsers: credentials hashes never leave the server. */
export function redactPayload(payload: unknown): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !SECRET_KEYS.has(k))
          .map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return walk(payload) as Record<string, unknown>;
}

/**
 * What the browser gets of an event. `stripped` (organization events for Members, docs/design/organizations.md section 6)
 * carries only type, stream, seq and actor: live invalidation works without leaking org-level content.
 */
export function toVisibleEvent(e: StoredEvent, level: 'full' | 'stripped' = 'full'): VisibleEvent {
  return {
    seq: Number(e.seq),
    type: e.event.type,
    streamId: e.streamId,
    payload: level === 'stripped' ? {} : redactPayload(e.event.payload),
    actor: e.actor,
    projectId: e.scope.projectId,
    createdAt: e.createdAt.toISOString(),
  };
}

/** The viewer of a socket: the user, their role in the socket's organization and their projects. */
export interface SocketViewer extends EventViewer {
  orgId: string | null;
}

export const accessOf = (v: SocketViewer, e: StoredEvent): 'full' | 'stripped' | false =>
  eventAccess(
    v,
    {
      audience: e.scope.audience,
      orgId: e.scope.orgId,
      projectId: e.scope.projectId,
      userId: e.scope.userId ?? null,
    },
    v.orgId,
  );

export const loadProjects = async (db: Queryable, userId: string) =>
  new Set(await visibleProjectIds(db, userId));

const COLS = `seq, id, stream_id, stream_version, type, payload, actor_kind, actor_id, org_id, project_id, audience, user_id, correlation_id, causation_id, created_at`;

/** Visible events after `afterSeq`, oldest first, at most `limit` (callers pass RESYNC_THRESHOLD + 1). */
export async function replayVisible(
  db: Queryable,
  viewer: SocketViewer,
  afterSeq: bigint,
  limit: number,
): Promise<StoredEvent[]> {
  const r = await rows(
    db,
    `SELECT ${COLS} FROM events WHERE seq > $6 AND ${EVENT_VISIBILITY_SQL} ORDER BY seq LIMIT $7`,
    [
      viewer.userId,
      viewer.kind === 'super_admin',
      [...(viewer.visibleProjectIds as ReadonlySet<string>)],
      viewer.orgId,
      viewer.orgRole as OrgRole | null,
      afterSeq.toString(),
      limit,
    ],
  );
  return r.map(rowToEvent);
}
