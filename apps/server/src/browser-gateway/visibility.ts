import { type AuthUser, canSeeEvent, type VisibleEvent } from '@aom/shared';
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

export function toVisibleEvent(e: StoredEvent): VisibleEvent {
  return {
    seq: Number(e.seq),
    type: e.event.type,
    streamId: e.streamId,
    payload: redactPayload(e.event.payload),
    actor: e.actor,
    projectId: e.scope.projectId,
    createdAt: e.createdAt.toISOString(),
  };
}

export const canSee = (user: AuthUser, e: StoredEvent, projects: ReadonlySet<string>): boolean =>
  canSeeEvent(
    user,
    { audience: e.scope.audience, orgId: e.scope.orgId, projectId: e.scope.projectId },
    projects,
  );

export const loadProjects = async (db: Queryable, userId: string) =>
  new Set(await visibleProjectIds(db, userId));

const COLS = `seq, id, stream_id, stream_version, type, payload, actor_kind, actor_id, org_id, project_id, audience, correlation_id, causation_id, created_at`;

/** Visible events after `afterSeq`, oldest first, at most `limit` (callers pass RESYNC_THRESHOLD + 1). */
export async function replayVisible(
  db: Queryable,
  user: AuthUser,
  projects: ReadonlySet<string>,
  afterSeq: bigint,
  limit: number,
): Promise<StoredEvent[]> {
  const r = await rows(
    db,
    `SELECT ${COLS} FROM events WHERE seq > $4 AND ${EVENT_VISIBILITY_SQL} ORDER BY seq LIMIT $5`,
    [user.id, user.role === 'admin', [...projects], afterSeq.toString(), limit],
  );
  return r.map(rowToEvent);
}
