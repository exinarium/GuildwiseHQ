import {
  type EventViewer,
  eventAccess,
  type OrgRole,
  parseBoardConfig,
  type VisibleEvent,
} from '@aom/shared';
import { EVENT_VISIBILITY_SQL, visibleProjectIds } from '../authz/scope.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
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

// ---------------------------------------------------------------------------------------------- session privacy

/**
 * Events of a discovery or boardroom session are organization-scope, so by their audience every Owner and Admin would get
 * their full payload (messages, notes, minutes). A session is private to its creator and its user participants, so for anyone
 * else the payload is stripped like a Member's: the event still tells the browser something changed. While a boardroom's first
 * round is sealed, the speakers' words are held back from the participants too (the same rule the read paths apply).
 */
const SESSION_CONTENT_EVENTS = new Set([
  'SessionThreadCreated',
  'SessionThreadUpdated',
  'ThreadParticipantAdded',
  'ThreadParticipantUpdated',
  'ThreadMessagePosted',
  'SessionTurnQueued',
  'SessionTurnStarted',
  'SessionTurnRequeued',
  'SessionTurnCompleted',
  'SessionTurnFailed',
  'DelegateCompleted',
  'DelegateGrantChanged',
  'DiscoveryQuestionAsked',
  'DiscoveryQuestionWithdrawn',
  'DiscoveryAnswerProposed',
  'DiscoveryQuestionAnswered',
  'DiscoveryNoteAdded',
  'DiscoveryNoteUpdated',
  'DiscoveryProposalRaised',
  'DiscoveryProposalResolved',
  'BoardRoundPlanned',
  'BoardNoteAdded',
  'BoardNoteUpdated',
  'BoardNoteMerged',
  'BoardDisagreementRecorded',
  'BoardDecisionRaised',
  'BoardDecisionResolved',
]);

/** Events of a document; one that comes from a session (a minutes, brief or PRD draft) is as private as the session. */
const DOCUMENT_EVENTS = new Set([
  'DocumentCreated',
  'DocumentVersionSaved',
  'DocumentStatusChanged',
  'DocumentPublishQueued',
]);

export interface SessionAudience {
  /** Creator and user participants. */
  users: ReadonlySet<string>;
  /** The thread is a boardroom whose first round is still sealed. */
  sealed: boolean;
}

/** Who may see the content of this event, when it belongs to a session thread; null: it does not. */
export async function sessionAudienceOf(db: Queryable, e: StoredEvent): Promise<SessionAudience | null> {
  if (DOCUMENT_EVENTS.has(e.event.type)) return e.scope.audience === 'org' ? documentAudienceOf(db, e) : null;
  if (!SESSION_CONTENT_EVENTS.has(e.event.type) || e.scope.audience !== 'org') return null;
  const threadId = (e.event.payload as { threadId?: unknown }).threadId;
  if (typeof threadId !== 'string') return null;
  const t = await one(
    db,
    `SELECT kind, created_by, session_config FROM threads WHERE id=$1 AND kind IN ('discovery','boardroom','persona_chat')`,
    [threadId],
  );
  if (!t) return null;
  const p = await rows(
    db,
    `SELECT ref_id FROM thread_participants WHERE thread_id=$1 AND kind='user' AND removed_at IS NULL`,
    [threadId],
  );
  const cfg = t.kind === 'boardroom' ? parseBoardConfig(t.session_config) : null;
  return {
    users: new Set([...(t.created_by ? [t.created_by as string] : []), ...p.map((r) => r.ref_id as string)]),
    sealed: !!cfg && cfg.round >= 1 && cfg.revealedRound < 1 && cfg.stage !== 'setup',
  };
}

/**
 * A document that lists session threads as its sources (`documents.source_thread_ids`, or the event's own list for a document
 * that is being created) is visible in full to the creators and user participants of those sessions only. Owners and Admins
 * who are not in the session get it stripped, like its messages. A document with no session source is not concerned.
 */
async function documentAudienceOf(db: Queryable, e: StoredEvent): Promise<SessionAudience | null> {
  const p = e.event.payload as { docId?: unknown; sourceThreadIds?: unknown };
  if (typeof p.docId !== 'string') return null;
  let sources: string[] = Array.isArray(p.sourceThreadIds) ? (p.sourceThreadIds as string[]) : [];
  const d = await one(db, 'SELECT source_thread_ids FROM documents WHERE id=$1', [p.docId]);
  if (d) sources = [...new Set([...sources, ...((d.source_thread_ids as string[] | null) ?? [])])];
  if (!sources.length) return null;
  const threads = await rows(
    db,
    `SELECT id, created_by FROM threads WHERE id = ANY($1::uuid[]) AND kind IN ('discovery','boardroom','persona_chat')`,
    [sources],
  );
  if (!threads.length) return null;
  const parts = await rows(
    db,
    `SELECT ref_id FROM thread_participants WHERE thread_id = ANY($1::uuid[]) AND kind='user' AND removed_at IS NULL`,
    [threads.map((t) => t.id)],
  );
  return {
    users: new Set([
      ...threads.map((t) => t.created_by as string).filter(Boolean),
      ...parts.map((r) => r.ref_id as string),
    ]),
    sealed: false,
  };
}

/** True for what the speakers say in round 1 of a boardroom (their messages, notes and disagreements, and what edits them). */
function isSealedContent(e: StoredEvent): boolean {
  const type = e.event.type;
  const pl = e.event.payload as {
    round?: number | null;
    data?: { round?: number; purpose?: string };
    by?: { kind?: string };
  };
  if (type === 'ThreadMessagePosted') return pl.data?.round === 1 && pl.data?.purpose === 'board_speaker';
  if (type === 'BoardNoteAdded' || type === 'BoardDisagreementRecorded')
    return pl.round === 1 && pl.by?.kind !== 'user';
  return type === 'BoardNoteUpdated' || type === 'BoardNoteMerged';
}

/** The level a viewer gets of an event after the session rules. */
export function sessionLevel(
  level: 'full' | 'stripped' | false,
  viewer: SocketViewer,
  e: StoredEvent,
  aud: SessionAudience | null,
): 'full' | 'stripped' | false {
  if (level !== 'full' || !aud) return level;
  if (!aud.users.has(viewer.userId)) return 'stripped';
  if (aud.sealed && isSealedContent(e)) return 'stripped';
  return level;
}
