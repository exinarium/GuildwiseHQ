import { randomUUID } from 'node:crypto';
import {
  type AgentStats,
  type ApplyRecommendationResponse,
  canManageAgentInOrg,
  DEFAULT_AVATAR_STYLE,
  HR_DESK_SUBKIND,
  HR_WINDOW_DAYS,
  type HrBoardResponse,
  isOrgManager,
  type OrgRole,
  type Recommendation,
  type ResetRoleResponse,
  type RoleExtensions,
  RoleExtensionsSchema,
  type RoleUpdate,
  randomAvatarSeed,
  streamId,
  type WorkQuality,
} from '@aom/shared';
import { orgRoleOf, type Who } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadRole } from '../catalogue/loader.ts';
import { agentScope, fireAgent, manageableAgent, suggestNames } from '../commands/agents.ts';
import { orgScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput, StoredEvent } from '../eventstore/types.ts';
import { assertWithinLimit } from '../orgs/limits.ts';
import { listAgents } from '../queries/agents.ts';
import { computeRecommendations } from './recommendations.ts';
import { computeTrack, type StatsAgent } from './track-record.ts';

const statsAgent = (a: { id: string; roleKey: string; hiredAt: string; status: string }): StatsAgent => ({
  id: a.id,
  roleKey: a.roleKey,
  hiredAt: new Date(a.hiredAt),
  retired: a.status === 'retired',
});

/** The HR board for `userId`: visible agents with stats against the role average, recommendations, role updates. */
export async function hrBoard(
  ctx: Ctx,
  who: Who,
  projectId?: string,
  department?: string,
): Promise<HrBoardResponse> {
  const now = ctx.clock.now();
  const agents = (await listAgents(ctx, who.userId, who.orgId, projectId, department)).filter(
    (a) => a.status !== 'retired',
  );
  const track = await computeTrack(ctx.pool, agents.map(statsAgent), now);
  const names = new Map(
    (
      await rows<{ id: string; display_name: string }>(
        ctx.pool,
        'SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])',
        [[...new Set(agents.map((a) => a.hiredByUserId))]],
      )
    ).map((u) => [u.id, u.display_name]),
  );
  const blocked = await rows(
    ctx.pool,
    `SELECT id, ref, title, last_agent_id FROM cards WHERE status='blocked' AND last_agent_id = ANY($1::uuid[]) ORDER BY number`,
    [agents.map((a) => a.id)],
  );
  return {
    windowDays: HR_WINDOW_DAYS,
    agents: agents.map((agent) => {
      const t = track.get(agent.id) as NonNullable<ReturnType<typeof track.get>>;
      return {
        agent,
        hiredByName: names.get(agent.hiredByUserId) ?? 'unknown',
        blockedOn: blocked
          .filter((c) => c.last_agent_id === agent.id)
          .map((c) => ({ cardId: c.id as string, ref: c.ref as string, title: c.title as string })),
        stats: t.stats,
        quality: t.quality,
      };
    }),
    recommendations: (await listRecommendations(ctx, who, projectId)).map((r) => r.rec),
    roleUpdates: await roleUpdates(ctx, who),
  };
}

export async function agentStats(
  ctx: Ctx,
  who: Who,
  agentId: string,
): Promise<{ stats: AgentStats; quality: WorkQuality }> {
  const all = (await listAgents(ctx, who.userId, who.orgId)).filter((a) => a.status !== 'retired');
  const agent = all.find((a) => a.id === agentId);
  if (!agent) throw notFound('agent not found');
  const track = await computeTrack(ctx.pool, all.map(statsAgent), ctx.clock.now());
  const t = track.get(agentId) as NonNullable<ReturnType<typeof track.get>>;
  return { stats: t.stats, quality: t.quality };
}

interface Listed {
  rec: Recommendation;
  orgId: string;
}

/**
 * Recommendations the user may see: those about agents visible to them (an additional manager sees the project's
 * agents, never the owner's org-wide ones), with `canApply` set for the owner and for the hiring manager of the agent.
 * Standing-order proposals are the owner's to apply.
 */
export async function listRecommendations(ctx: Ctx, who: Who, projectId?: string): Promise<Listed[]> {
  const visible = (await listAgents(ctx, who.userId, who.orgId, projectId)).filter(
    (a) => a.status !== 'retired',
  );
  const byId = new Map(visible.map((a) => [a.id, a]));
  const orgIds = [...new Set([who.orgId, ...visible.map((a) => a.orgId)])];
  const roles = new Map<string, OrgRole | null>();
  for (const id of orgIds)
    roles.set(id, id === who.orgId ? who.role : await orgRoleOf(ctx.pool, who.userId, id));
  const out: Listed[] = [];
  for (const orgId of orgIds) {
    const role = roles.get(orgId) ?? null;
    for (const r of await computeRecommendations(ctx, orgId)) {
      const agent = r.agentId ? byId.get(r.agentId) : undefined;
      if (r.agentId && !agent) continue;
      if (!r.agentId && !(orgId === who.orgId && isOrgManager({ orgRole: role }))) continue;
      if (projectId && !agent && r.agentId === null) continue;
      const canApply =
        r.action.type === 'none'
          ? false
          : r.ownerOnly
            ? isOrgManager({ orgRole: role })
            : !!agent &&
              canManageAgentInOrg({ userId: who.userId, orgRole: role, managerUserId: agent.managerUserId });
      const { ownerOnly: _ownerOnly, ...rest } = r;
      out.push({ rec: { ...rest, canApply }, orgId });
    }
  }
  return out;
}

/** One-click apply. Every change is a real event: AgentChanged, AgentHired, AgentRetired, or a desk approval. */
export async function applyRecommendation(
  ctx: Ctx,
  user: AuthSession['user'],
  who: Who,
  id: string,
): Promise<ApplyRecommendationResponse> {
  const listed = (await listRecommendations(ctx, who)).find((l) => l.rec.id === id);
  if (!listed) throw notFound('that recommendation no longer applies (it may already be applied)');
  const { rec, orgId } = listed;
  if (rec.action.type === 'none')
    throw badRequest('not_applicable', 'this recommendation is advice only; there is nothing to apply');
  if (!rec.canApply)
    throw forbidden('only the organization Owner and Admins or the hiring manager can apply this');
  const action = rec.action;
  const applied = (effect: string, deskItemId?: string): AppendInput => ({
    streamId: streamId.agent(rec.agentId ?? orgId),
    event: {
      type: 'RecommendationApplied',
      payload: {
        orgId,
        recommendationId: rec.id,
        kind: rec.kind,
        ...(rec.agentId ? { agentId: rec.agentId } : {}),
        appliedBy: user.id,
        effect,
        ...(deskItemId ? { deskItemId } : {}),
      },
    },
    actor: userActor(user.id),
    scope: orgScope(orgId),
  });

  switch (action.type) {
    case 'change_model':
      return withAppendTx(ctx.pool, async (tx) => {
        const a = await manageableAgent(tx, user, action.agentId);
        if (a.status === 'retired') throw conflict('agent_retired', 'agent is retired');
        if (a.model !== action.fromModel)
          throw conflict(
            'stale_recommendation',
            'the agent changed since this was suggested; reload the board',
          );
        const effect = `${a.name} moved from ${a.model} to ${action.model}`;
        await ctx.store.append(
          [
            {
              streamId: streamId.agent(a.id),
              event: { type: 'AgentChanged', payload: { agentId: a.id, changes: { model: action.model } } },
              actor: userActor(user.id),
              scope: agentScope(a),
            },
            applied(effect),
          ],
          { tx },
        );
        return { applied: true as const, effect, deskItemId: null, agentIds: [a.id] };
      });

    case 'standing_order':
      return withAppendTx(ctx.pool, async (tx) => {
        const open = await one<{ id: string }>(
          tx,
          `SELECT id FROM desk_items WHERE org_id=$1 AND subkind=$2 AND status='open' AND lower(body)=lower($3)`,
          [orgId, HR_DESK_SUBKIND.standingOrder, action.text],
        );
        const deskItemId = open?.id ?? randomUUID();
        const effect = 'Proposed a standing order on the desk';
        const events: AppendInput[] = [];
        if (!open)
          events.push({
            streamId: streamId.desk(deskItemId),
            event: {
              type: 'DeskItemCreated',
              payload: {
                deskItemId,
                kind: 'approval',
                subkind: HR_DESK_SUBKIND.standingOrder,
                title: `Add a standing order: ${action.topic ?? rec.title}`,
                body: action.text,
                blocking: false,
                pinned: false,
                options: [],
                affectedCardIds: [],
                askedBy: { kind: 'system' },
              },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(orgId),
          });
        events.push(applied(effect, deskItemId));
        await ctx.store.append(events, { tx });
        return { applied: true as const, effect, deskItemId, agentIds: rec.agentId ? [rec.agentId] : [] };
      });

    case 'split_role':
      return withAppendTx(ctx.pool, async (tx) => {
        const a = await manageableAgent(tx, user, action.agentId);
        if (a.status !== 'active') throw conflict('agent_inactive', 'agent is not active');
        if (!a.workstation_id) throw conflict('needs_rehome', 'the agent has no workstation to hire onto');
        const role = await loadRole(tx, a.org_id, a.role_key);
        const levels = role?.definition.seniorityLevels ?? [a.seniority];
        let name = action.juniorName;
        if (await one(tx, 'SELECT 1 FROM agents WHERE org_id=$1 AND lower(name)=lower($2)', [a.org_id, name]))
          name = (await suggestNames(ctx, a.org_id, undefined, 1))[0] ?? `${name} 2`;
        await assertWithinLimit(tx, a.org_id, 'agents');
        const juniorId = randomUUID();
        const perms = a.permissions ?? {};
        const effect = `${a.name} now takes large cards (${action.seniorModel}); ${name} was hired for small ones (${action.juniorModel})`;
        await ctx.store.append(
          [
            {
              streamId: streamId.agent(a.id),
              event: {
                type: 'AgentChanged',
                payload: {
                  agentId: a.id,
                  changes: {
                    model: action.seniorModel,
                    ...(levels.includes('senior') ? { seniority: 'senior' as const } : {}),
                    permissions: { ...perms, riskTiers: ['large'] },
                  },
                },
              },
              actor: userActor(user.id),
              scope: agentScope(a),
            },
            {
              streamId: streamId.agent(juniorId),
              event: {
                type: 'AgentHired',
                payload: {
                  agentId: juniorId,
                  orgId: a.org_id,
                  ...(a.hired_for_project_id ? { projectId: a.hired_for_project_id } : {}),
                  allowedProjectIds: a.allowed_project_ids ?? null,
                  focusProjectIds: a.focus_project_ids ?? [],
                  hiredByUserId: user.id,
                  workstationId: a.workstation_id,
                  name,
                  roleKey: a.role_key,
                  roleVersion: a.role_version,
                  seniority: levels.includes('junior') ? 'junior' : a.seniority,
                  runtime: a.runtime,
                  model: action.juniorModel,
                  ...(a.effort ? { effort: a.effort } : {}),
                  skills: a.skills,
                  permissions: { ...perms, riskTiers: ['small'] },
                  capacity: a.capacity,
                  isDevops: false,
                  avatarSeed: randomAvatarSeed(),
                  avatarStyle: DEFAULT_AVATAR_STYLE,
                },
              },
              actor: userActor(user.id),
              scope: agentScope(a),
            },
            applied(effect),
          ],
          { tx },
        );
        return { applied: true as const, effect, deskItemId: null, agentIds: [a.id, juniorId] };
      });

    case 'fire': {
      const { releasedCardIds } = await fireAgent(ctx, user, action.agentId);
      const effect = `${rec.agentName ?? 'The agent'} was let go${releasedCardIds.length ? `; ${releasedCardIds.length} card(s) went back to the queue` : ''}`;
      await ctx.store.append([applied(effect)]);
      return { applied: true as const, effect, deskItemId: null, agentIds: [action.agentId] };
    }

    default:
      throw badRequest('not_applicable', 'this recommendation is advice only; there is nothing to apply');
  }
}

// ------------------------------------------------------------------------------- built-in role defaults

/**
 * Built-in roles the owner extended whose default has moved on since: the owner sees them on the HR board and may reset
 * a role to the new default, which drops the extensions (shown here first).
 */
export async function roleUpdates(ctx: Ctx, who: Who): Promise<RoleUpdate[]> {
  const list = await rows(
    ctx.pool,
    // A built-in role has an update for this org when the owner's extensions were written against an older default,
    // or when any of the org's active agents still runs an older version (the usual case: no extensions at all).
    `WITH keys AS (
       SELECT role_key FROM role_extensions WHERE org_id = $1
       UNION
       SELECT role_key FROM agents WHERE org_id = $1 AND status <> 'retired'
     )
     SELECT k.role_key, e.base_version, e.extensions, r.version AS latest, r.definition
       FROM keys k
       JOIN LATERAL (SELECT version, definition FROM role_definitions
                      WHERE org_id IS NULL AND key = k.role_key AND status = 'active'
                      ORDER BY version DESC LIMIT 1) r ON true
       LEFT JOIN role_extensions e ON e.org_id = $1 AND e.role_key = k.role_key
      WHERE (e.role_key IS NOT NULL AND r.version > e.base_version)
         OR EXISTS (SELECT 1 FROM agents a WHERE a.org_id = $1 AND a.role_key = k.role_key
                     AND a.status <> 'retired' AND a.role_version < r.version)
      ORDER BY k.role_key`,
    [who.orgId],
  );
  const out: RoleUpdate[] = [];
  for (const r of list) {
    const stale = await one<{ n: number }>(
      ctx.pool,
      'SELECT count(*)::int AS n FROM agents WHERE org_id=$1 AND role_key=$2 AND status <> $3 AND role_version < $4',
      [who.orgId, r.role_key, 'retired', r.latest],
    );
    out.push({
      roleKey: r.role_key,
      roleName: r.definition.name,
      extensionBaseVersion: r.base_version ?? null,
      latestVersion: r.latest,
      purpose: r.definition.purpose,
      extensions: RoleExtensionsSchema.parse(
        r.extensions ?? { instructions: '', skills: [], standingOrders: [] },
      ),
      agentsOnOlderVersion: Number(stale?.n ?? 0),
    });
  }
  return out;
}

/**
 * Owner and Admins: resets a built-in role to its current default. `RoleResetToDefault` records what was dropped; agents of
 * the role move to the new version in the same append.
 */
export async function resetRole(
  ctx: Ctx,
  user: AuthSession['user'],
  who: Who,
  roleKey: string,
): Promise<ResetRoleResponse> {
  if (!isOrgManager({ orgRole: who.role }))
    throw forbidden('only the organization Owner and Admins can reset a role');
  return withAppendTx(ctx.pool, async (tx) => {
    const ext = await one(tx, 'SELECT * FROM role_extensions WHERE org_id=$1 AND role_key=$2 FOR UPDATE', [
      who.orgId,
      roleKey,
    ]);
    const latest = await one<{ version: number }>(
      tx,
      `SELECT version FROM role_definitions WHERE org_id IS NULL AND key=$1 AND status='active' ORDER BY version DESC LIMIT 1`,
      [roleKey],
    );
    if (!latest) throw notFound('built-in role not found');
    const stale = await rows(
      tx,
      `SELECT * FROM agents WHERE org_id=$1 AND role_key=$2 AND status <> 'retired' AND role_version < $3 ORDER BY hired_at`,
      [who.orgId, roleKey, latest.version],
    );
    if (!ext && stale.length === 0) throw conflict('nothing_to_reset', 'this role already uses the default');
    const dropped: RoleExtensions = ext
      ? RoleExtensionsSchema.parse(ext.extensions)
      : { instructions: '', skills: [], standingOrders: [] };
    const events: AppendInput[] = [
      {
        streamId: streamId.role(who.orgId, roleKey),
        event: {
          type: 'RoleResetToDefault',
          payload: { orgId: who.orgId, roleKey, toVersion: latest.version, droppedExtensions: dropped },
        },
        actor: userActor(user.id),
        scope: orgScope(who.orgId),
      },
      ...stale.map(
        (a): AppendInput => ({
          streamId: streamId.agent(a.id),
          event: {
            type: 'AgentChanged',
            payload: { agentId: a.id, changes: { roleVersion: latest.version } },
          },
          actor: userActor(user.id),
          scope: agentScope(a),
        }),
      ),
    ];
    await ctx.store.append(events, { tx });
    return {
      roleKey,
      toVersion: latest.version,
      droppedExtensions: dropped,
      updatedAgentIds: stale.map((a) => a.id as string),
    };
  });
}

// ----------------------------------------------------------------------------------------------- hooks

/**
 * An approved HR standing-order proposal becomes an org-wide standing order in the ledger (the existing M2 mechanism
 * every agent loads at shift start). The edited text of the approval wins.
 */
export function registerHrHook(ctx: Ctx): () => void {
  return ctx.store.subscribe(async (e: StoredEvent) => {
    try {
      const ev = e.event;
      if (ev.type !== 'DeskItemResolved' || ev.payload.resolution !== 'approved') return;
      const d = await one(ctx.pool, `SELECT org_id, title, body FROM desk_items WHERE id=$1 AND subkind=$2`, [
        ev.payload.deskItemId,
        HR_DESK_SUBKIND.standingOrder,
      ]);
      if (!d) return;
      const entryId = randomUUID();
      await ctx.store.append([
        {
          streamId: streamId.ledger(entryId),
          event: {
            type: 'LedgerEntryAdded',
            payload: {
              entryId,
              scope: 'standing_order',
              title:
                String(d.title)
                  .replace(/^Add a standing order: /, '')
                  .slice(0, 120) || 'Standing order',
              body: d.body,
              tags: ['hr'],
              sourceDeskItemId: ev.payload.deskItemId,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(d.org_id),
        },
      ]);
    } catch (err) {
      ctx.log.warn({ err }, 'standing order hook failed');
    }
  });
}
