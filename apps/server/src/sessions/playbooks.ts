import {
  builtinCapabilities,
  type CapabilityMeta,
  isTemplateTagged,
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
import { orgScope, runnerActor, userActor } from '../commands/common.ts';
import { raiseOrCoalesce } from '../commands/desk-coalesce.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, notFound } from '../errors.ts';

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
      if (!items.some((i) => i.key === req.key))
        throw badRequest('unknown_playbook', `"${req.key}" is not a playbook you can grant`);
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
  return startForAgent(ctx, workstationId, agent, p.data, shift.chat_user_id ?? null);
}

async function startForAgent(
  ctx: Ctx,
  workstationId: string,
  agent: Row,
  p: PlaybookRunParams,
  /** The person whose message started the chat this runs from (Q64); null for a card shift or any run with no chat user. */
  chatUserId: string | null = null,
): Promise<Reply> {
  const managerId = agent.manager_user_id as string;
  // The session belongs to the person in the chat (Q64) when there is one who is still in the organization and may run the
  // playbook; otherwise to the agent's manager, as before.
  let ownerId = managerId;
  // a session runs on its creator's own workstation: the chat person's (the one the chat runs on when it is theirs); with none,
  // it stays with the manager, whose workstation the agent is on
  let stationId: string | undefined = agent.workstation_id ?? workstationId;
  if (chatUserId && chatUserId !== managerId && (await orgRoleOf(ctx.pool, chatUserId, agent.org_id))) {
    const visible = await runnablePlaybooks(ctx.pool, agent.org_id, chatUserId);
    const mine = await one(
      ctx.pool,
      `SELECT id FROM workstations WHERE user_id=$1 AND status='active'
        ORDER BY (id = $2::uuid) DESC, connected DESC, last_seen_at DESC NULLS LAST, paired_at LIMIT 1`,
      [chatUserId, agent.workstation_id ?? workstationId],
    );
    if (visible.some((i) => i.key === p.key) && mine) {
      ownerId = chatUserId;
      stationId = mine.id as string;
    }
  }
  const role = await orgRoleOf(ctx.pool, ownerId, agent.org_id);
  if (!role) return [false, undefined, "the agent's manager is no longer in the organization"];
  const since = new Date(ctx.clock.now().getTime() - 24 * 3600_000);
  const recent = await one(
    ctx.pool,
    `SELECT count(*)::int AS n FROM threads
      WHERE org_id=$1 AND kind='discovery' AND created_at >= $2
        AND session_config->'playbookRun'->'startedBy'->>'agentId' = $3`,
    [agent.org_id, since, agent.id],
  );
  if ((recent?.n ?? 0) >= PLAYBOOK_LIMITS.maxPerDay)
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
  const who: Who = { userId: ownerId, orgId: agent.org_id, role };
  const state = await ctx.services.discovery.create(
    who,
    {
      title: titleOf(item.name, p.input ?? ''),
      stance: 'facilitator',
      ceoMode: 'owner_only',
      playbook: item.key,
      idea: p.input ?? '',
      workstationId: stationId,
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
    actor: runnerActor(workstationId),
    scope: orgScope(agent.org_id),
  });
  return [
    true,
    {
      threadId: state.threadId,
      message: `Started the guided session "${item.name}" for ${ownerId === managerId ? `${agent.name}'s manager` : 'the person you are chatting with'}. It needs their answers and is on their desk; continue your work, do not wait for it.`,
    },
  ];
}
