import {
  canUnlinkWorkstation,
  isOrgManager,
  type RetireAgentRef,
  type RetirePreview,
  type RetireWorkstationRequest,
  type RetireWorkstationResponse,
  streamId,
} from '@aom/shared';
import type { Who } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, HttpError, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgWorkstationSql } from '../queries/move-targets.ts';
import { sandboxGate } from './agents.ts';
import { cardMessage, orgScope, projectScope, userActor } from './common.ts';
import { devopsRetireEvents } from './devops-retire.ts';
import { assertTargetRuntime, loadSourceWorkstation, prepareAgentMove } from './sharing.ts';
import { unlinkWorkstationIn } from './workstations.ts';

const ref = (a: Row): RetireAgentRef => ({ id: a.id, name: a.name, roleKey: a.role_key });
const notKnown = () => notFound('workstation not found in this organization', 'workstation_not_found');

/**
 * Who is in a shift right now on the workstation or among its agents (any status of the shift but `ended`). Other
 * organizations' agents are included only with `allOrgs` (the caller may unpair the machine).
 */
async function workingAgents(
  db: Queryable,
  workstationId: string,
  agentIds: string[],
  orgId: string,
  allOrgs: boolean,
) {
  return rows(
    db,
    `SELECT DISTINCT ON (a.id) a.id, a.name, a.role_key, c.ref AS card_ref
       FROM shifts s JOIN agents a ON a.id = s.agent_id LEFT JOIN cards c ON c.id = s.card_id
      WHERE s.status <> 'ended' AND (s.workstation_id = $1 OR a.id = ANY($2::uuid[]))
        AND ($3::boolean OR a.org_id = $4)
      ORDER BY a.id`,
    [workstationId, agentIds, allOrgs, orgId],
  );
}

/** Open cards whose worktree lives on the workstation and that nobody holds: they restart anywhere. */
async function homedCards(db: Queryable, workstationId: string, orgId: string, allOrgs: boolean) {
  return rows(
    db,
    `SELECT * FROM cards
      WHERE home_workstation_id = $1 AND claim_id IS NULL AND status NOT IN ('done','cancelled')
        AND ($3::boolean OR org_id = $2)
      ORDER BY ref`,
    [workstationId, orgId, allOrgs],
  );
}

async function agentsOn(db: Queryable, workstationId: string, lock: boolean): Promise<Row[]> {
  return rows(
    db,
    `SELECT * FROM agents WHERE workstation_id = $1 AND status <> 'retired' ORDER BY hired_at, id${lock ? ' FOR UPDATE' : ''}`,
    [workstationId],
  );
}

/** What retiring would do, without writing anything. */
export async function retirePreview(ctx: Ctx, who: Who, workstationId: string): Promise<RetirePreview> {
  if (!isOrgManager({ orgRole: who.role }))
    throw forbidden('only the organization Owner and Admins can retire a workstation');
  const src = await loadSourceWorkstation(ctx.pool, who.orgId, workstationId);
  if (!src) throw notKnown();
  const ws = await one(ctx.pool, 'SELECT user_id FROM workstations WHERE id=$1', [workstationId]);
  const active = src.status === 'active';
  const all = await agentsOn(ctx.pool, workstationId, false);
  // Other organizations' agents are only visible to the person who may unpair the machine (as the POST requires).
  const seesOthers = active && ws?.user_id === who.userId;
  const relevant = all.filter((a) => a.org_id === who.orgId || seesOthers);
  const working = await workingAgents(
    ctx.pool,
    workstationId,
    relevant.map((a) => a.id as string),
    who.orgId,
    seesOthers,
  );
  const cards = await homedCards(ctx.pool, workstationId, who.orgId, seesOthers);
  return {
    workstation: {
      id: src.id,
      name: src.name,
      status: active ? 'active' : 'unlinked',
      mine: ws?.user_id === who.userId,
    },
    agents: relevant
      .filter((a) => !a.is_devops)
      .map((a) => ({ ...ref(a), status: a.status as string, otherOrg: a.org_id !== who.orgId })),
    devops: relevant.filter((a) => a.is_devops && a.status === 'active').map(ref),
    working: working.map((a) => ({ ...ref(a), cardRef: (a.card_ref as string | null) ?? null })),
    homedCards: cards.map((c) => ({ ref: c.ref as string, title: c.title as string })),
    canUnpair: active && ws?.user_id === who.userId,
  };
}

/**
 * Retires a workstation and hands its agents over, all or nothing in one append transaction. A retired workstation is
 * an `unlinked` one with no agent left on it (agents, history and project assignments are kept). Refused while an agent
 * of it is in a shift. `move` runs the single-move checks for every agent and refuses the whole retirement when one of
 * them fails; `needs_rehome` lets the agents be re-homed one by one later.
 */
export async function retireWorkstation(
  ctx: Ctx,
  who: Who,
  workstationId: string,
  req: RetireWorkstationRequest,
): Promise<RetireWorkstationResponse> {
  if (!isOrgManager({ orgRole: who.role }))
    throw forbidden('only the organization Owner and Admins can retire a workstation');
  return withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(tx, 'SELECT * FROM workstations WHERE id=$1 FOR UPDATE', [workstationId]);
    const src = ws ? await loadSourceWorkstation(tx, who.orgId, workstationId) : undefined;
    if (!ws || !src) throw notKnown();
    const active = ws.status === 'active';
    if (active && !canUnlinkWorkstation({ id: who.userId }, ws.user_id))
      throw new HttpError(
        403,
        'workstation_not_yours',
        `Only the person who owns ${ws.name} can unpair it. Use "Move all agents" to take this organization's agents off it.`,
      );
    const by = { userId: who.userId, actor: userActor(who.userId) };

    // Other organizations' agents only matter while the machine is still paired: unpairing takes it from all of them.
    const onIt = (await agentsOn(tx, workstationId, true)).filter((a) => a.org_id === who.orgId || active);
    const devops = onIt.filter((a) => a.is_devops);
    const ceos = onIt.filter((a) => a.role_key === 'ceo' && !a.is_devops);
    const normal = onIt.filter((a) => !a.is_devops && a.role_key !== 'ceo' && a.org_id === who.orgId);
    const otherOrg = onIt.filter((a) => !a.is_devops && a.role_key !== 'ceo' && a.org_id !== who.orgId);

    const working = await workingAgents(
      tx,
      workstationId,
      onIt.map((a) => a.id as string),
      who.orgId,
      // Paired: the caller is the machine's user (checked above) and unpairing affects every organization on it.
      active,
    );
    if (working.length > 0) {
      const names = working.map((a) => (a.card_ref ? `${a.name} (${a.card_ref})` : a.name)).join(', ');
      throw conflict(
        'agents_working',
        `Retiring is not possible while these agents are working: ${names}. Try again when their shifts end.`,
        {
          agents: working.map((a) => ({ ...ref(a), cardRef: (a.card_ref as string | null) ?? null })),
        },
      );
    }

    const toHandOver = [...normal, ...ceos, ...otherOrg];
    if (toHandOver.length > 0 && !req.handover)
      throw new HttpError(
        400,
        'handover_required',
        'choose what happens to its agents: move them to another workstation or mark them as needing a new home',
      );
    const handover: 'move' | 'needs_rehome' | 'none' =
      toHandOver.length > 0 ? (req.handover ?? 'none') : 'none';

    const events: AppendInput[] = [];
    const moved: Row[] = [];
    const needsRehome: Row[] = [];

    const needsRehomeEvent = (a: Row): AppendInput => ({
      streamId: streamId.agent(a.id),
      event: {
        type: 'AgentNeedsRehome',
        payload: {
          agentId: a.id,
          by: who.userId,
          fromWorkstationId: workstationId,
          reason: 'workstation_retired',
        },
      },
      actor: by.actor,
      scope: orgScope(a.org_id),
    });
    const noHomeEvent = (a: Row): AppendInput => ({
      streamId: streamId.agent(a.id),
      event: {
        type: 'AgentRehomed',
        payload: {
          agentId: a.id,
          workstationId: null,
          fromWorkstationId: workstationId,
          runtime: a.runtime,
          model: a.model,
        },
      },
      actor: by.actor,
      scope: orgScope(a.org_id),
    });

    if (handover === 'move') {
      const target = await one(
        tx,
        `SELECT w.id, w.name, w.status, w.user_id, w.simulation_org_id, w.runtimes, ${orgWorkstationSql('w', '$2::uuid')} AS in_org
           FROM workstations w WHERE w.id = $1`,
        [req.targetWorkstationId, who.orgId],
      );
      if (!target || !target.in_org) throw notKnown();
      if (target.id === workstationId)
        throw conflict('same_workstation', 'pick another workstation than the one you are retiring');
      const failed: Array<{ id: string; name: string; code: string; message: string }> = [];
      const collect = (a: Row, e: unknown) => {
        if (!(e instanceof HttpError)) throw e;
        failed.push({ id: a.id, name: a.name, code: e.code, message: e.message });
      };
      for (const a of normal) {
        try {
          assertTargetRuntime(target, a);
          const p = await prepareAgentMove(
            ctx,
            tx,
            by,
            a,
            {
              workstationId: target.id,
              runtime: a.runtime,
              model: a.model,
              ...(req.acknowledgeUnsandboxed ? { acknowledgeUnsandboxed: true } : {}),
            },
            // Retiring empties the workstation, so the organization's count of workstations does not rise.
            { skipLimitCheck: true },
          );
          events.push(p.append);
          moved.push(a);
        } catch (e) {
          collect(a, e);
        }
      }
      for (const a of ceos) {
        // The CEO follows only the Owner onto the Owner's own workstation; otherwise it has no home until the Owner picks one.
        const ownerTarget =
          who.role === 'owner' &&
          a.org_id === who.orgId &&
          (target.user_id === who.userId || target.simulation_org_id === a.org_id);
        if (!ownerTarget) {
          events.push(noHomeEvent(a));
          continue;
        }
        try {
          const ack = await sandboxGate(
            ctx,
            tx,
            who.userId,
            target.id,
            a.runtime,
            req.acknowledgeUnsandboxed,
            {
              roleKey: 'ceo',
              model: a.model,
            },
          );
          events.push({
            streamId: streamId.agent(a.id),
            event: {
              type: 'AgentRehomed',
              payload: {
                agentId: a.id,
                workstationId: target.id,
                fromWorkstationId: workstationId,
                runtime: a.runtime,
                model: a.model,
                ...(ack ? { unsandboxedAck: ack } : {}),
              },
            },
            actor: by.actor,
            scope: orgScope(a.org_id),
          });
        } catch (e) {
          collect(a, e);
        }
      }
      if (failed.length > 0)
        throw conflict(
          'handover_incomplete',
          `These agents cannot move to ${target.name}: ${failed.map((f) => `${f.name} (${f.message})`).join('; ')}`,
          { failed },
        );
      for (const a of otherOrg) {
        events.push(needsRehomeEvent(a));
        needsRehome.push(a);
      }
    } else if (handover === 'needs_rehome') {
      for (const a of [...normal, ...otherOrg]) {
        events.push(needsRehomeEvent(a));
        needsRehome.push(a);
      }
      for (const a of ceos) events.push(noHomeEvent(a));
    }

    // Open cards whose worktree was here restart from the base branch on any workstation.
    const cards = await homedCards(tx, workstationId, who.orgId, active);
    const me = await one(tx, 'SELECT display_name FROM users WHERE id=$1', [who.userId]);
    for (const c of cards) {
      events.push(
        {
          streamId: streamId.card(c.id),
          event: { type: 'CardRehomed', payload: { cardId: c.id, by: who.userId } },
          actor: by.actor,
          scope: projectScope(c.org_id, c.project_id),
        },
        cardMessage(
          c,
          { kind: 'system' },
          'system',
          `${me?.display_name ?? 'An administrator'} retired ${ws.name}: the ${c.stage} stage restarts from the base branch on any workstation.`,
        ),
      );
    }

    // One audit entry per organization whose agents were handed over (and always one for the acting organization).
    const orgIds = new Set<string>([who.orgId, ...[...otherOrg, ...ceos].map((a) => a.org_id as string)]);
    for (const orgId of orgIds) {
      events.push({
        streamId: streamId.workstation(workstationId),
        event: {
          type: 'WorkstationRetired',
          payload: {
            workstationId,
            orgId,
            by: who.userId,
            handover,
            targetWorkstationId: handover === 'move' ? (req.targetWorkstationId ?? null) : null,
            movedAgentIds: moved
              .filter((a) => a.org_id === orgId)
              .map((a) => a.id as string)
              .concat(
                handover === 'move' && orgId === who.orgId
                  ? ceos.filter((c) => events.some((e) => movedCeo(e, c.id))).map((c) => c.id as string)
                  : [],
              ),
            needsRehomeAgentIds: needsRehome.filter((a) => a.org_id === orgId).map((a) => a.id as string),
            unlinked: active,
          },
        },
        actor: by.actor,
        scope: orgScope(orgId),
      });
    }
    await ctx.store.append(events, { tx });

    // Still paired: retiring also unpairs it (this retires its DevOps engineers). An unpaired one only needs its DevOps retired.
    if (active) await unlinkWorkstationIn(ctx, tx as Tx, who.userId, workstationId, ws.user_id, 'owner');
    else {
      const left = devops.filter((a) => a.status === 'active' && a.org_id === who.orgId);
      if (left.length > 0)
        await ctx.store.append(
          await devopsRetireEvents(tx, {
            agents: left,
            reason: 'workstation_unpaired',
            actor: by.actor,
            by: who.userId,
          }),
          { tx },
        );
    }

    return {
      workstationId,
      unlinked: active,
      handover,
      moved: moved.map(ref),
      needsRehome: needsRehome.map(ref),
      retiredDevops: devops.filter((a) => a.status === 'active').map(ref),
      rehomedCardIds: cards.map((c) => c.id as string),
    };
  });
}

/** Whether the event moves the agent to a workstation (the CEO's move to the Owner's workstation). */
function movedCeo(e: AppendInput, agentId: string): boolean {
  const ev = e.event as { type: string; payload: { agentId?: string; workstationId?: string | null } };
  return ev.type === 'AgentRehomed' && ev.payload.agentId === agentId && ev.payload.workstationId != null;
}
