import { randomUUID } from 'node:crypto';
import {
  type CreateSessionRequest,
  isOrgManager,
  type ParticipantDto,
  type ParticipantInput,
  type PatchSessionRequest,
  type PostSessionMessageRequest,
  SESSION_THREAD_KINDS,
  type SessionDto,
  streamId,
  type ThreadMessageDto,
} from '@aom/shared';
import { orgRoleOf, type Who } from '../auth/org-context.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { resolvePersona } from '../capabilities/registry.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { threadMessageById } from '../queries/threads.ts';
import { sessionCost } from '../sessions/cost.ts';
import { workstationServesOrg } from '../simulation/fit.ts';
import { orgScope, userActor } from './common.ts';

/** `ad-hoc-<slug>`: a persona cast on the fly from a one-line brief (the brief is its stance; it is not in the registry). */
export const isAdHocPersona = (key: string): boolean => key.startsWith('ad-hoc-');

const SESSION_KIND_SQL = SESSION_THREAD_KINDS.map((k) => `'${k}'`).join(',');

export function participantDto(r: Row): ParticipantDto {
  return {
    id: r.id,
    threadId: r.thread_id,
    kind: r.kind,
    refId: r.ref_id,
    seat: r.seat,
    stance: r.stance ?? null,
    displayName: r.display_name,
    addedAt: iso(r.added_at) as string,
  };
}

export async function listParticipants(
  db: Queryable,
  threadId: string,
  includeRemoved = false,
): Promise<Row[]> {
  return rows(
    db,
    `SELECT * FROM thread_participants WHERE thread_id=$1 ${includeRemoved ? '' : 'AND removed_at IS NULL'} ORDER BY added_at, id`,
    [threadId],
  );
}

export async function sessionDto(ctx: Ctx, t: Row, db: Queryable = ctx.pool): Promise<SessionDto> {
  const last = await one(db, 'SELECT max(created_at) AS at FROM thread_messages WHERE thread_id=$1', [t.id]);
  return {
    threadId: t.id,
    kind: t.kind,
    title: t.title,
    projectId: t.project_id ?? null,
    facilitatorAgentId: t.agent_id ?? null,
    workstationId: t.workstation_id ?? null,
    workstationOnline: !!t.workstation_id && ctx.services.runners.isOnline(t.workstation_id),
    config: t.session_config ?? {},
    createdBy: t.created_by ?? null,
    createdAt: iso(t.created_at) as string,
    lastMessageAt: iso(last?.at),
    cost: await sessionCost(db, t),
    participants: (await listParticipants(db, t.id)).map(participantDto),
  };
}

/**
 * A session thread the user takes part in: the creator, or a user participant. Anyone else gets 404 (a session is private
 * to its participants, whatever the organization role).
 */
export async function loadSession(
  db: Queryable,
  userId: string,
  threadId: string,
  lock = false,
): Promise<Row> {
  const t = await one(
    db,
    `SELECT t.* FROM threads t
      WHERE t.id=$1 AND t.kind IN (${SESSION_KIND_SQL}) AND t.deleted_at IS NULL
        AND (t.created_by=$2 OR EXISTS (SELECT 1 FROM thread_participants p
              WHERE p.thread_id=t.id AND p.kind='user' AND p.ref_id=$2::text AND p.removed_at IS NULL))
      ${lock ? 'FOR UPDATE OF t' : ''}`,
    [threadId, userId],
  );
  if (!t) throw notFound('session not found');
  return t;
}

/** Changing who is in the room, its config or its workstation: the creator or an Owner/Admin of the organization. */
export async function assertSessionManager(db: Queryable, userId: string, t: Row): Promise<void> {
  if (t.created_by === userId) return;
  if (!isOrgManager({ orgRole: await orgRoleOf(db, userId, t.org_id) }))
    throw forbidden('only the session creator, an Owner or an Admin can change this session');
}

/** The workstation a user's session runs on when none is named: the agent's, else the user's own (online first). */
async function defaultWorkstation(
  db: Queryable,
  userId: string,
  agent: Row | undefined,
): Promise<string | undefined> {
  if (agent?.workstation_id) return agent.workstation_id;
  const w = await one(
    db,
    `SELECT id FROM workstations WHERE user_id=$1 AND status='active'
      ORDER BY connected DESC, last_seen_at DESC NULLS LAST, paired_at LIMIT 1`,
    [userId],
  );
  return w?.id;
}

async function assertWorkstation(
  ctx: Ctx,
  db: Queryable,
  orgId: string,
  workstationId: string,
): Promise<void> {
  const w = await one(db, `SELECT id, user_id FROM workstations WHERE id=$1 AND status='active'`, [
    workstationId,
  ]);
  if (!w || !(await orgRoleOf(db, w.user_id, orgId)))
    throw badRequest('unknown_workstation', 'workstation not found');
  if (!(await workstationServesOrg(db, workstationId, orgId)))
    throw badRequest('simulation_workstation', 'that workstation does not serve this organization');
}

/** One participant, checked and with its display name; events are built by the caller. */
async function checkParticipant(
  db: Queryable,
  orgId: string,
  p: ParticipantInput,
): Promise<{ displayName: string }> {
  if (p.kind === 'user') {
    const u = await one(
      db,
      `SELECT u.display_name FROM org_members om JOIN users u ON u.id = om.user_id
        WHERE om.org_id=$1 AND om.user_id=$2 AND om.status='active'`,
      [orgId, p.refId],
    );
    if (!u) throw badRequest('unknown_participant', 'that user is not a member of the organization');
    return { displayName: p.displayName ?? u.display_name };
  }
  if (p.kind === 'agent') {
    const a = await one(db, `SELECT name FROM agents WHERE id=$1 AND org_id=$2 AND status <> 'retired'`, [
      p.refId,
      orgId,
    ]);
    if (!a) throw badRequest('unknown_participant', 'agent not found');
    return { displayName: p.displayName ?? a.name };
  }
  if (isAdHocPersona(p.refId)) {
    if (!p.stance?.trim())
      throw badRequest(
        'ad_hoc_persona_needs_brief',
        'an ad-hoc persona needs a one-line brief as its stance',
      );
    return { displayName: p.displayName ?? p.refId.slice('ad-hoc-'.length).replace(/-/g, ' ') };
  }
  const persona = await resolvePersona(db, orgId, p.refId);
  if (!persona) throw badRequest('unknown_persona', `persona "${p.refId}" is not in the registry`);
  return { displayName: p.displayName ?? persona.name };
}

function participantEvent(
  threadId: string,
  p: ParticipantInput,
  displayName: string,
  scope: AppendInput['scope'],
  by: string,
): AppendInput {
  return {
    streamId: streamId.thread(threadId),
    event: {
      type: 'ThreadParticipantAdded',
      payload: {
        threadId,
        participantId: randomUUID(),
        kind: p.kind,
        refId: p.refId,
        seat: p.seat,
        ...(p.stance ? { stance: p.stance } : {}),
        displayName,
      },
    },
    actor: userActor(by),
    scope,
  };
}

/**
 * Events of a session are organization events whatever its project: the browser stream gives them to Owners and Admins in
 * full and to Members stripped of their payload, so a session stays private to the people in it.
 */
export const sessionScope = (t: Row) => orgScope(t.org_id);

/** `POST /api/sessions`: a thread of kind `discovery` or `boardroom`, its participants and its first workstation. */
export async function createSession(ctx: Ctx, who: Who, req: CreateSessionRequest): Promise<SessionDto> {
  if (!isOrgManager({ orgRole: who.role })) throw forbidden('only an Owner or an Admin can start a session');
  return withAppendTx(ctx.pool, async (tx) => {
    if (req.projectId) {
      const p = await loadVisibleProject(tx, who.userId, req.projectId);
      if (p.org_id !== who.orgId) throw notFound('project not found');
    }
    let agent: Row | undefined;
    if (req.facilitatorAgentId) {
      agent = await one(tx, `SELECT * FROM agents WHERE id=$1 AND org_id=$2 AND status <> 'retired'`, [
        req.facilitatorAgentId,
        who.orgId,
      ]);
      if (!agent) throw badRequest('unknown_participant', 'facilitator agent not found');
    }
    const workstationId = req.workstationId ?? (await defaultWorkstation(tx, who.userId, agent));
    if (workstationId) await assertWorkstation(ctx, tx, who.orgId, workstationId);

    const list: ParticipantInput[] = [...req.participants];
    if (!list.some((p) => p.kind === 'user' && p.refId === who.userId))
      list.unshift({ kind: 'user', refId: who.userId, seat: 'Owner' });
    if (agent && !list.some((p) => p.kind === 'agent' && p.refId === agent.id))
      list.push({ kind: 'agent', refId: agent.id, seat: 'Facilitator' });
    const seen = new Set<string>();
    for (const p of list) {
      const k = `${p.kind}:${p.refId}`;
      if (seen.has(k)) throw badRequest('duplicate_participant', 'a participant is listed twice');
      seen.add(k);
    }

    const threadId = randomUUID();
    const scope = orgScope(who.orgId);
    const events: AppendInput[] = [
      {
        streamId: streamId.thread(threadId),
        event: {
          type: 'SessionThreadCreated',
          payload: {
            threadId,
            kind: req.kind,
            title: req.title,
            createdBy: who.userId,
            ...(req.projectId ? { projectId: req.projectId } : {}),
            ...(agent ? { agentId: agent.id } : {}),
            ...(workstationId ? { workstationId } : {}),
            config: req.config,
          },
        },
        actor: userActor(who.userId),
        scope,
      },
    ];
    for (const p of list) {
      const { displayName } = await checkParticipant(tx, who.orgId, p);
      events.push(participantEvent(threadId, p, displayName, scope, who.userId));
    }
    await ctx.store.append(events, { tx });
    return sessionDto(ctx, (await one(tx, 'SELECT * FROM threads WHERE id=$1', [threadId])) as Row, tx);
  });
}

export async function listSessions(
  ctx: Ctx,
  who: Who,
  q: { kind?: string | undefined; projectId?: string | undefined },
): Promise<SessionDto[]> {
  const list = await rows(
    ctx.pool,
    `SELECT t.* FROM threads t
      WHERE t.org_id=$1 AND t.kind IN (${SESSION_KIND_SQL}) AND t.deleted_at IS NULL
        AND ($3::text IS NULL OR t.kind=$3) AND ($4::uuid IS NULL OR t.project_id=$4)
        AND (t.created_by=$2 OR EXISTS (SELECT 1 FROM thread_participants p
              WHERE p.thread_id=t.id AND p.kind='user' AND p.ref_id=$2::text AND p.removed_at IS NULL))
      ORDER BY t.created_at DESC, t.id`,
    [who.orgId, who.userId, q.kind ?? null, q.projectId ?? null],
  );
  return Promise.all(list.map((t) => sessionDto(ctx, t)));
}

export async function getSession(ctx: Ctx, userId: string, threadId: string): Promise<SessionDto> {
  return sessionDto(ctx, await loadSession(ctx.pool, userId, threadId));
}

export async function patchSession(
  ctx: Ctx,
  userId: string,
  threadId: string,
  req: PatchSessionRequest,
): Promise<SessionDto> {
  return withAppendTx(ctx.pool, async (tx) => {
    const t = await loadSession(tx, userId, threadId, true);
    await assertSessionManager(tx, userId, t);
    if (req.workstationId) await assertWorkstation(ctx, tx, t.org_id, req.workstationId);
    await ctx.store.append(
      [
        {
          streamId: streamId.thread(threadId),
          event: {
            type: 'SessionThreadUpdated',
            payload: {
              threadId,
              ...(req.title ? { title: req.title } : {}),
              ...(req.config ? { config: req.config } : {}),
              ...(req.workstationId ? { workstationId: req.workstationId } : {}),
            },
          },
          actor: userActor(userId),
          scope: sessionScope(t),
        },
      ],
      { tx },
    );
    return sessionDto(ctx, (await one(tx, 'SELECT * FROM threads WHERE id=$1', [threadId])) as Row, tx);
  });
}

export async function addParticipant(
  ctx: Ctx,
  userId: string,
  threadId: string,
  req: ParticipantInput,
): Promise<ParticipantDto> {
  return withAppendTx(ctx.pool, async (tx) => {
    const t = await loadSession(tx, userId, threadId, true);
    await assertSessionManager(tx, userId, t);
    const { displayName } = await checkParticipant(tx, t.org_id, req);
    const existing = await one(
      tx,
      'SELECT 1 FROM thread_participants WHERE thread_id=$1 AND kind=$2 AND ref_id=$3 AND removed_at IS NULL',
      [threadId, req.kind, req.refId],
    );
    if (existing) throw conflict('duplicate_participant', 'already in this session');
    const ev = participantEvent(threadId, req, displayName, sessionScope(t), userId);
    await ctx.store.append([ev], { tx });
    const id = (ev.event as { payload: { participantId: string } }).payload.participantId;
    return participantDto((await one(tx, 'SELECT * FROM thread_participants WHERE id=$1', [id])) as Row);
  });
}

async function loadParticipant(db: Queryable, threadId: string, participantId: string): Promise<Row> {
  const p = await one(
    db,
    'SELECT * FROM thread_participants WHERE id=$1 AND thread_id=$2 AND removed_at IS NULL',
    [participantId, threadId],
  );
  if (!p) throw notFound('participant not found');
  return p;
}

export async function updateParticipant(
  ctx: Ctx,
  userId: string,
  threadId: string,
  participantId: string,
  req: { seat?: string | undefined; stance?: string | undefined },
): Promise<ParticipantDto> {
  return withAppendTx(ctx.pool, async (tx) => {
    const t = await loadSession(tx, userId, threadId, true);
    await assertSessionManager(tx, userId, t);
    await loadParticipant(tx, threadId, participantId);
    await ctx.store.append(
      [
        {
          streamId: streamId.thread(threadId),
          event: {
            type: 'ThreadParticipantUpdated',
            payload: {
              threadId,
              participantId,
              ...(req.seat ? { seat: req.seat } : {}),
              ...(req.stance !== undefined ? { stance: req.stance } : {}),
            },
          },
          actor: userActor(userId),
          scope: sessionScope(t),
        },
      ],
      { tx },
    );
    return participantDto(
      (await one(tx, 'SELECT * FROM thread_participants WHERE id=$1', [participantId])) as Row,
    );
  });
}

export async function removeParticipant(
  ctx: Ctx,
  userId: string,
  threadId: string,
  participantId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const t = await loadSession(tx, userId, threadId, true);
    await assertSessionManager(tx, userId, t);
    const p = await loadParticipant(tx, threadId, participantId);
    if (p.kind === 'user' && p.ref_id === t.created_by)
      throw conflict('cannot_remove_creator', 'the session creator cannot be removed');
    await ctx.store.append(
      [
        {
          streamId: streamId.thread(threadId),
          event: { type: 'ThreadParticipantRemoved', payload: { threadId, participantId } },
          actor: userActor(userId),
          scope: sessionScope(t),
        },
      ],
      { tx },
    );
  });
}

/** A message of a human participant. It does not queue a turn: the facilitator logic (or the caller) does that. */
export async function postSessionMessage(
  ctx: Ctx,
  userId: string,
  threadId: string,
  req: PostSessionMessageRequest,
): Promise<ThreadMessageDto> {
  return withAppendTx(ctx.pool, async (tx) => {
    const t = await loadSession(tx, userId, threadId);
    const me = await one(
      tx,
      `SELECT id FROM thread_participants WHERE thread_id=$1 AND kind='user' AND ref_id=$2 AND removed_at IS NULL`,
      [threadId, userId],
    );
    const messageId = randomUUID();
    await ctx.store.append(
      [
        {
          streamId: streamId.thread(threadId),
          event: {
            type: 'ThreadMessagePosted',
            payload: {
              threadId,
              messageId,
              authorKind: 'user',
              authorUserId: userId,
              kind: req.kind,
              body: req.body,
              data: { ...req.data, ...(me ? { participantId: me.id } : {}) },
            },
          },
          actor: userActor(userId),
          scope: sessionScope(t),
        },
      ],
      { tx },
    );
    return (await threadMessageById(tx, messageId)) as ThreadMessageDto;
  });
}
