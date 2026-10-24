import { createHash, randomUUID } from 'node:crypto';
import {
  builtinCapabilities,
  type CapabilityMeta,
  isTemplateTagged,
  normalizeScopes,
  PLAYBOOK_LIMITS,
  type PlaybookGrantsDto,
  type PlaybookRunParams,
  PlaybookRunParamsSchema,
  type PlaybookRunRequest,
  type PlaybookRunState,
  playbookSteps,
  type SetPlaybookGrantRequest,
  type SlashCommand,
  type SlashContext,
  streamId,
} from '@aom/shared';
import { orgRoleOf, type Who } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { effectiveRegistry } from '../capabilities/registry.ts';
import { manageableAgent } from '../commands/agents.ts';
import { orgScope, runnerActor, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import { raiseOrCoalesce } from '../commands/desk-coalesce.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { gateAction } from '../governance/gates.ts';
import { agentScopeFacts, assertScopesConfirmed, scopeWarning } from '../governance/scopes.ts';

/** `[ok, result, error]`, as every rpc handler of the gateway answers. */
type Reply = [boolean, unknown?, string?];

/** The registry entries of kind playbook a person may start (usable now, not a template), by visibility rules of the asker. */
async function runnablePlaybooks(
  db: Queryable,
  orgId: string,
  userId: string,
  projectId?: string,
): Promise<Array<CapabilityMeta & { packId?: string; visibility?: 'org' | 'private' }>> {
  const reg = await effectiveRegistry(db, orgId, {
    kind: 'playbook',
    usableOnly: true,
    userId,
    ...(projectId ? { projectId } : {}),
  });
  return reg.items.filter((i) => !isTemplateTagged(i.tags));
}

/**
 * The `/` menu: the playbooks and skills the asker may use. The registry's own visibility rules decide (a private pack is
 * listed to its owner only; an organization pack only when approved at its pinned commit and unchanged). In a session
 * composer only playbooks are useful (a skill is an instruction for an agent's chat).
 */
export async function slashCommands(
  ctx: Ctx,
  who: Who,
  q: { context: SlashContext; projectId?: string | undefined; agentId?: string | undefined },
): Promise<SlashCommand[]> {
  const reg = await effectiveRegistry(ctx.pool, who.orgId, {
    usableOnly: true,
    userId: who.userId,
    ...(q.projectId ? { projectId: q.projectId } : {}),
  });
  // A chat with an agent: the agent loads the capability itself, and a private pack reaches only the agents its owner granted.
  const grantedPacks = new Set<string>(
    q.agentId
      ? (await rows(ctx.pool, 'SELECT pack_id FROM pack_agent_grants WHERE agent_id=$1', [q.agentId])).map(
          (x) => x.pack_id as string,
        )
      : [],
  );
  const out: SlashCommand[] = [];
  for (const i of reg.items) {
    if (q.agentId && i.visibility === 'private' && !(i.packId && grantedPacks.has(i.packId))) continue;
    if (i.kind === 'persona') continue;
    if (i.kind === 'playbook' && isTemplateTagged(i.tags)) continue;
    if (i.kind === 'skill' && q.context === 'session') continue;
    out.push({
      kind: i.kind,
      key: i.key,
      name: i.name,
      description: i.description,
      source: i.source,
      ...(i.packId ? { packId: i.packId } : {}),
      ...(i.visibility ? { visibility: i.visibility } : {}),
      ...(normalizeScopes((i as { scopes?: string[] }).scopes).length
        ? { scopes: normalizeScopes((i as { scopes?: string[] }).scopes) }
        : {}),
      canStartSession: i.kind === 'playbook',
    });
  }
  // playbooks first, then skills; each by name
  return out.sort(
    (a, b) => (a.kind === b.kind ? 0 : a.kind === 'playbook' ? -1 : 1) || a.name.localeCompare(b.name),
  );
}

/** The state a new guided session starts with: step titles when the server can read them (a built-in playbook). */
function initialRun(
  item: CapabilityMeta,
  key: string,
  origin: PlaybookRunState['startedBy'],
): PlaybookRunState {
  const own =
    item.source === 'builtin'
      ? builtinCapabilities().find((c) => c.kind === 'playbook' && c.key === key)
      : undefined;
  const steps = own?.kind === 'playbook' ? playbookSteps(own.steps, own.files).map((s) => s.title) : [];
  return {
    key,
    name: item.name,
    steps,
    step: null,
    stepTitle: null,
    total: steps.length || null,
    startedBy: origin,
  };
}

const titleOf = (name: string, input: string): string => {
  const base = input.trim() ? `${name}: ${input.trim().split('\n')[0]}` : name;
  return base.length > 200 ? `${base.slice(0, 199)}…` : base;
};

/** `POST /api/playbooks/run`: a person starts a guided session with a playbook from the `/` menu. */
export async function runPlaybookSession(
  ctx: Ctx,
  who: Who,
  req: PlaybookRunRequest,
): Promise<{ threadId: string; path: string }> {
  const items = await runnablePlaybooks(ctx.pool, who.orgId, who.userId, req.projectId);
  const item = items.find((i) => i.key === req.key);
  if (!item)
    throw badRequest(
      'unknown_playbook',
      `"${req.key}" is not a playbook you can run (it must be approved and visible to you)`,
    );
  const state = await ctx.services.discovery.create(
    who,
    {
      title: req.title ?? titleOf(item.name, req.input),
      ...(req.projectId ? { projectId: req.projectId } : {}),
      stance: 'facilitator',
      ceoMode: 'owner_only',
      playbook: item.key,
      idea: req.input,
      ...(req.workstationId ? { workstationId: req.workstationId } : {}),
    },
    undefined,
    initialRun(item, item.key, { kind: 'user', agentId: null, agentName: null }),
  );
  return { threadId: state.threadId, path: `/discovery/${state.threadId}` };
}

// ------------------------------------------------------------------------------------------------------- grants

export async function playbookGrantKeys(db: Queryable, agentId: string): Promise<string[]> {
  const r = await rows(
    db,
    'SELECT playbook_key FROM agent_playbook_grants WHERE agent_id=$1 ORDER BY playbook_key',
    [agentId],
  );
  return r.map((x) => x.playbook_key as string);
}

export async function getPlaybookGrants(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
): Promise<PlaybookGrantsDto> {
  const a = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [agentId]);
  if (!a) throw notFound('agent not found');
  const role = await orgRoleOf(ctx.pool, user.id, a.org_id);
  if (!role) throw notFound('agent not found');
  const canManage = role === 'owner' || role === 'admin' || a.manager_user_id === user.id;
  // Who may see the agent at all is the agent page's rule; the grants are shown to those who can manage it, and to
  // Owners and Admins. Anyone else gets the list without being told it can be changed.
  return { agentId, keys: await playbookGrantKeys(ctx.pool, agentId), canManage };
}

/** Owners, Admins and the agent's manager grant or revoke (the HR rule). Off by default; an event per change is the audit. */
export async function setPlaybookGrant(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  req: SetPlaybookGrantRequest,
): Promise<PlaybookGrantsDto> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await manageableAgent(tx, user, agentId);
    if (a.status === 'retired') throw conflict('agent_retired', 'agent is retired');
    const had = await one(tx, 'SELECT 1 FROM agent_playbook_grants WHERE agent_id=$1 AND playbook_key=$2', [
      agentId,
      req.key,
    ]);
    if (!!had === req.granted) return;
    if (req.granted) {
      const n = await one(tx, 'SELECT count(*)::int AS n FROM agent_playbook_grants WHERE agent_id=$1', [
        agentId,
      ]);
      if ((n?.n ?? 0) >= PLAYBOOK_LIMITS.maxGrantsPerAgent)
        throw badRequest(
          'too_many_grants',
          `an agent may be granted at most ${PLAYBOOK_LIMITS.maxGrantsPerAgent} playbooks`,
        );
      // The granter must be able to see the playbook themselves (a private pack of someone else cannot be handed on).
      const items = await runnablePlaybooks(tx, a.org_id, user.id);
      const item = items.find((i) => i.key === req.key) as
        | (CapabilityMeta & { scopes?: string[] })
        | undefined;
      if (!item) throw badRequest('unknown_playbook', `"${req.key}" is not a playbook you can grant`);
      // S-B1: a playbook that needs a scope the agent lacks is granted only when the granter confirms it
      assertScopesConfirmed(
        scopeWarning(normalizeScopes(item.scopes), await agentScopeFacts(tx, a)),
        req.confirmScopes,
      );
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: {
            type: 'AgentPlaybookGranted',
            payload: {
              agentId,
              orgId: a.org_id,
              playbookKey: req.key,
              grantedBy: user.id,
              granted: req.granted,
            },
          },
          actor: userActor(user.id),
          scope: orgScope(a.org_id),
        },
      ],
      { tx },
    );
  });
  return getPlaybookGrants(ctx, user, agentId);
}

// ---------------------------------------------------------------------------------------------- `aom playbook run`

/**
 * `aom playbook run <key> [--input ".."]` from an agent's shift or chat: allowed only for a playbook the agent was granted.
 * The guided session belongs to the agent's manager (they answer it) and runs on the agent's workstation; a desk item tells
 * the manager their answers are needed. An agent starts at most `maxPerDay` such sessions a day.
 */
export async function playbookRunRpc(
  ctx: Ctx,
  workstationId: string,
  shift: Row,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = PlaybookRunParamsSchema.safeParse(params);
  if (!p.success)
    return [false, undefined, 'usage: aom playbook run <key> [--input "<what you want from it>"]'];
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [shift.agent_id]);
  if (!agent || agent.status === 'retired') return [false, undefined, 'unknown agent'];
  const granted = await one(
    ctx.pool,
    'SELECT 1 FROM agent_playbook_grants WHERE agent_id=$1 AND playbook_key=$2',
    [agent.id, p.data.key],
  );
  if (!granted)
    return [
      false,
      undefined,
      `\`aom playbook run\` is not available for "${p.data.key}": nobody granted this agent that playbook (a manager grants it on the agent's page)`,
    ];
  // S-B1: an agent set to ask before it starts a playbook waits for an approval of this one
  const gate = await gateAction(ctx, {
    agent,
    actionClass: 'playbook_run',
    // the approval is for this playbook with this input, not for any later run of it with another input
    fingerprint: `playbook:${p.data.key}:${createHash('sha256')
      .update(p.data.input ?? '')
      .digest('hex')
      .slice(0, 16)}`,
    summary: `run the playbook "${p.data.key}"${p.data.input ? `: ${p.data.input.slice(0, 160)}` : ''}`,
    projectId: shift.project_id ?? null,
    cardId: shift.card_id ?? null,
  });
  if (!gate.ok) return [false, undefined, gate.message];
  return startForAgent(
    ctx,
    workstationId,
    agent,
    p.data,
    shift.chat_user_id ?? null,
    ctx.services.chat?.threadOfChat(shift.id) ?? null,
  );
}

/** The subkind of the desk item that asks the chat person where an agent-started playbook should run (Q69). */
export const PLAYBOOK_WORKSTATION_SUBKIND = 'playbook_workstation';

async function startForAgent(
  ctx: Ctx,
  workstationId: string,
  agent: Row,
  p: PlaybookRunParams,
  /** The person whose message started the chat this runs from (Q64); null for a card shift or any run with no chat user. */
  chatUserId: string | null = null,
  /** The chat the agent works in, told how the request ended (Q69). */
  chatThreadId: string | null = null,
): Promise<Reply> {
  // Q69 follow-up: the chat person declined this playbook in this chat; the agent does not ask again there (a different
  // playbook or a new chat is fine). The declined request row is the projection of `PlaybookRunDecided`, so this survives replay.
  if (chatThreadId) {
    const declined = await one(
      ctx.pool,
      `SELECT 1 FROM playbook_run_requests WHERE agent_id=$1 AND playbook_key=$2 AND chat_thread_id=$3 AND status='declined'`,
      [agent.id, p.key, chatThreadId],
    );
    if (declined)
      return [
        false,
        undefined,
        `the person you are chatting with declined "${p.key}" in this chat: do not ask for it again here. Continue without it, or ask them in the chat what they would like instead.`,
      ];
  }
  const managerId = agent.manager_user_id as string;
  // The session belongs to the person in the chat (Q64) when there is one who is still in the organization, may run the
  // playbook and has a workstation of their own; otherwise to the agent's manager, as before.
  let ownerId = managerId;
  const agentStation: string = agent.workstation_id ?? workstationId;
  let stationId: string = agentStation;
  // Q69: a session runs on its creator's own workstation. When the agent's workstation is not one of the chat person's, the
  // session does not start on one chosen for them: the person is asked to pick one of their own or decline.
  let ask: Array<{ id: string; name: string }> | null = null;
  if (chatUserId && (await orgRoleOf(ctx.pool, chatUserId, agent.org_id))) {
    const visible = await runnablePlaybooks(ctx.pool, agent.org_id, chatUserId);
    const mine = await rows<{ id: string; name: string }>(
      ctx.pool,
      `SELECT id, name FROM workstations WHERE user_id=$1 AND status='active'
        ORDER BY (id = $2::uuid) DESC, connected DESC, last_seen_at DESC NULLS LAST, paired_at`,
      [chatUserId, agentStation],
    );
    if (visible.some((i) => i.key === p.key) && mine.length > 0) {
      ownerId = chatUserId;
      if (mine.some((m) => m.id === agentStation)) stationId = agentStation;
      else ask = mine;
    }
  }
  const role = await orgRoleOf(ctx.pool, ownerId, agent.org_id);
  if (!role) return [false, undefined, "the agent's manager is no longer in the organization"];
  const since = new Date(ctx.clock.now().getTime() - 24 * 3600_000);
  // sessions started, and requests asked (started ones are already among the sessions): a prompt is as much of the person's time
  const recent = await one(
    ctx.pool,
    `SELECT (SELECT count(*) FROM threads
              WHERE org_id=$1 AND kind='discovery' AND created_at >= $2
                AND session_config->'playbookRun'->'startedBy'->>'agentId' = $3::text)
          + (SELECT count(*) FROM playbook_run_requests
              WHERE org_id=$1 AND agent_id=$3::uuid AND requested_at >= $2 AND status <> 'started') AS n`,
    [agent.org_id, since, agent.id],
  );
  if (Number(recent?.n ?? 0) >= PLAYBOOK_LIMITS.maxPerDay)
    return [
      false,
      undefined,
      `at most ${PLAYBOOK_LIMITS.maxPerDay} playbook sessions a day per agent: the owner has unanswered ones to get through first`,
    ];
  const items = await runnablePlaybooks(ctx.pool, agent.org_id, ownerId);
  const item = items.find((i) => i.key === p.key);
  if (!item)
    return [
      false,
      undefined,
      `playbook "${p.key}" is not available (not approved, or not visible to the owner of this agent)`,
    ];
  if (ask && chatUserId)
    return askWhereToRun(ctx, workstationId, agent, item, p, chatUserId, chatThreadId, ask);
  const started = await launchSession(ctx, {
    agent,
    item,
    input: p.input ?? '',
    ownerId,
    role,
    stationId,
    managerId,
    actor: runnerActor(workstationId),
  });
  return [
    true,
    {
      threadId: started.threadId,
      message: `Started the guided session "${item.name}" for ${ownerId === managerId ? `${agent.name}'s manager` : 'the person you are chatting with'}. It needs their answers and is on their desk; continue your work, do not wait for it.`,
    },
  ];
}

type PlaybookItem = CapabilityMeta & { packId?: string; visibility?: 'org' | 'private' };

/** Opens the guided Discovery session of an agent-started playbook for `ownerId` on `stationId`, and puts it on their desk. */
async function launchSession(
  ctx: Ctx,
  o: {
    agent: Row;
    item: PlaybookItem;
    input: string;
    ownerId: string;
    role: string;
    stationId: string;
    managerId: string;
    actor: AppendInput['actor'];
  },
): Promise<{ threadId: string }> {
  const { agent, item, ownerId, managerId } = o;
  const who: Who = { userId: ownerId, orgId: agent.org_id, role: o.role as Who['role'] };
  const state = await ctx.services.discovery.create(
    who,
    {
      title: titleOf(item.name, o.input),
      stance: 'facilitator',
      ceoMode: 'owner_only',
      playbook: item.key,
      idea: o.input,
      workstationId: o.stationId,
    },
    undefined,
    initialRun(item, item.key, { kind: 'agent', agentId: agent.id, agentName: agent.name }),
  );
  await raiseOrCoalesce(ctx, {
    subjectKey: `playbook_session:${state.threadId}`,
    orgId: agent.org_id,
    kind: 'alert',
    subkind: 'playbook_input_needed',
    title: `${agent.name} started "${item.name}": your answers are needed`,
    body: `${agent.name} started the playbook "${item.name}" as a guided session${ownerId === managerId ? '' : ' from your chat'}. The facilitator asks you questions on the session page; nothing happens until you answer.`,
    data: {
      threadId: state.threadId,
      path: `/discovery/${state.threadId}`,
      agentId: agent.id,
      forUserId: ownerId,
    },
    askedBy: { kind: 'agent', agentId: agent.id },
    actor: o.actor,
    scope: orgScope(agent.org_id),
  });
  return { threadId: state.threadId };
}

/**
 * Q69: the chat person is asked, on their desk, which of their own workstations the playbook should run on, or to decline. The
 * request waits (it is a projection of its events); nothing starts before they answer. One open request per agent, person and
 * playbook.
 */
async function askWhereToRun(
  ctx: Ctx,
  workstationId: string,
  agent: Row,
  item: PlaybookItem,
  p: PlaybookRunParams,
  chatUserId: string,
  chatThreadId: string | null,
  mine: Array<{ id: string; name: string }>,
): Promise<Reply> {
  const open = await one(
    ctx.pool,
    `SELECT 1 FROM playbook_run_requests WHERE agent_id=$1 AND chat_user_id=$2 AND playbook_key=$3 AND status IN ('pending','accepted')`,
    [agent.id, chatUserId, item.key],
  );
  if (open)
    return [
      true,
      {
        requested: true,
        message: `The person you are chatting with was already asked where "${item.name}" should run. It is on their desk; continue your work, do not wait for it.`,
      },
    ];
  const requestId = randomUUID();
  const deskItemId = randomUUID();
  await ctx.store.append([
    {
      streamId: streamId.agent(agent.id),
      event: {
        type: 'PlaybookRunRequested',
        payload: {
          requestId,
          orgId: agent.org_id,
          agentId: agent.id,
          chatUserId,
          playbookKey: item.key,
          input: p.input ?? '',
          ...(chatThreadId ? { chatThreadId } : {}),
          deskItemId,
          workstationIds: mine.map((m) => m.id),
        },
      },
      actor: runnerActor(workstationId),
      scope: orgScope(agent.org_id),
    },
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'approval',
          subkind: PLAYBOOK_WORKSTATION_SUBKIND,
          title: `${agent.name} wants to start "${item.name}": which of your workstations should run it?`,
          body: `${agent.name} started the playbook "${item.name}" from your chat. It is a guided session you answer, and a session runs on its own person's workstation; ${agent.name} works on a workstation that is not yours. Pick one of yours to start it there, or decline and nothing starts.`,
          options: mine.map((m) => ({ id: m.id, label: m.name })),
          blocking: false,
          pinned: false,
          affectedCardIds: [],
          addresseeUserId: chatUserId,
          askedBy: { kind: 'agent', agentId: agent.id },
          data: { requestId, playbookKey: item.key, agentId: agent.id },
          subjectKey: `playbook_run:${requestId}`,
        },
      },
      actor: runnerActor(workstationId),
      scope: orgScope(agent.org_id),
    },
  ]);
  return [
    true,
    {
      requested: true,
      message: `Asked the person you are chatting with which of their workstations should run "${item.name}", or to decline. It is on their desk; nothing has started. Continue your work, do not wait for it.`,
    },
  ];
}

/**
 * The person answered the desk item (inside the desk's transaction): decline, or pick one of their own active workstations among
 * the ones offered. Records `PlaybookRunDecided`; the session is started after the transaction (`afterPlaybookRunDecision`).
 */
export async function resolvePlaybookRunIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  item: Row,
  resolution: 'approved' | 'rejected' | 'acknowledged',
  workstationId?: string,
): Promise<{ requestId: string; accepted: boolean }> {
  if (resolution === 'acknowledged')
    throw badRequest('wrong_resolution', 'pick one of your workstations to start it, or decline');
  const req = await one(tx, 'SELECT * FROM playbook_run_requests WHERE desk_item_id=$1 FOR UPDATE', [
    item.id,
  ]);
  if (!req) throw notFound('playbook request not found');
  if (req.chat_user_id !== user.id) throw forbidden('only the person in the chat decides where this runs');
  if (req.status !== 'pending') throw conflict('already_resolved', `this request is already ${req.status}`);
  let chosen: string | undefined;
  if (resolution === 'approved') {
    if (!workstationId || !(req.workstation_ids as string[]).includes(workstationId))
      throw badRequest('pick_a_workstation', 'pick one of the workstations offered');
    const own = await one(tx, `SELECT 1 FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`, [
      workstationId,
      user.id,
    ]);
    if (!own) throw badRequest('pick_a_workstation', 'that workstation is not one of yours any more');
    chosen = workstationId;
  }
  await ctx.store.append(
    [
      {
        streamId: streamId.agent(req.agent_id),
        event: {
          type: 'PlaybookRunDecided',
          payload: {
            requestId: req.request_id,
            orgId: req.org_id,
            decision: chosen ? 'accepted' : 'declined',
            ...(chosen ? { workstationId: chosen } : {}),
            decidedBy: user.id,
          },
        },
        actor: userActor(user.id),
        scope: orgScope(req.org_id),
      },
    ],
    { tx },
  );
  return { requestId: req.request_id, accepted: !!chosen };
}

/** After the desk transaction: start the chosen session, or tell the chat that the person declined. */
export async function afterPlaybookRunDecision(
  ctx: Ctx,
  d: { requestId: string; accepted: boolean },
): Promise<void> {
  const req = await one(ctx.pool, 'SELECT * FROM playbook_run_requests WHERE request_id=$1', [d.requestId]);
  if (!req) return;
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [req.agent_id]);
  const items = await runnablePlaybooks(ctx.pool, req.org_id, req.chat_user_id);
  const item = items.find((i) => i.key === req.playbook_key);
  const tell = async (body: string): Promise<void> => {
    if (!req.chat_thread_id) return;
    await ctx.store
      .append([
        {
          streamId: streamId.thread(req.chat_thread_id),
          event: {
            type: 'ThreadMessagePosted',
            payload: {
              threadId: req.chat_thread_id,
              messageId: randomUUID(),
              authorKind: 'system',
              kind: 'system',
              body,
              data: { playbookRequest: req.request_id },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(req.org_id),
        },
      ])
      .catch((err) => ctx.log.warn({ err }, 'could not tell the chat about the playbook request'));
  };
  const name = item?.name ?? req.playbook_key;
  if (!d.accepted) {
    await tell(`The playbook "${name}" was not started: you chose not to run it.`);
    return;
  }
  const role = await orgRoleOf(ctx.pool, req.chat_user_id, req.org_id);
  if (!agent || !item || !role || !req.workstation_id) {
    await tell(
      `The playbook "${name}" could not be started any more (it is not available, or you left the organization).`,
    );
    return;
  }
  const started = await launchSession(ctx, {
    agent,
    item,
    input: req.input,
    ownerId: req.chat_user_id,
    role,
    stationId: req.workstation_id,
    managerId: agent.manager_user_id,
    actor: userActor(req.chat_user_id),
  });
  await ctx.store.append([
    {
      streamId: streamId.agent(req.agent_id),
      event: {
        type: 'PlaybookRunStarted',
        payload: { requestId: req.request_id, orgId: req.org_id, sessionThreadId: started.threadId },
      },
      actor: userActor(req.chat_user_id),
      scope: orgScope(req.org_id),
    },
  ]);
  await tell(`Started the guided session "${name}" on the workstation you chose. It is on your desk.`);
}
