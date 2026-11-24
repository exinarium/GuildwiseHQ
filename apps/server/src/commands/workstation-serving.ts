import { CEO_ROLE_KEY, isLiveRunState, streamId, type WorkstationServingResponse } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { ceoBindEvents } from '../ceo/provision.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cardMessage, orgScope, projectScope, SYSTEM_ACTOR, userActor, userScope } from './common.ts';
import { devopsHireEvent } from './devops.ts';
import { devopsRetireEvents, releaseClaimsOfAgentEvents } from './devops-retire.ts';
import { requestStopIn } from './runs.ts';
import { deliver } from './workstation-setup.ts';

/**
 * "Works for" (R9, audit F4): a real workstation runs work of an organization only when its user switched that
 * organization on (`workstation_org_serving`, read by `wsServesOrgSql`). The rows come only from these explicit events:
 * pairing (the orgs the user owns), accept (`serveWorkstationIds`), "Works for", a hire onto one's own workstation, and
 * the `workstation-org-serving` data migration. Membership alone never switches a workstation on.
 */
export type ServingReason = 'owner_org' | 'accept' | 'works_for' | 'hire' | 'existing';

export function servingEvent(
  p: { workstationId: string; orgId: string; serving: boolean; by: string | null; reason: ServingReason },
  wsUserId: string,
): AppendInput {
  return {
    streamId: streamId.workstation(p.workstationId),
    event: { type: 'WorkstationOrgServingSet', payload: p },
    actor: p.by ? userActor(p.by) : SYSTEM_ACTOR,
    scope: userScope(wsUserId),
  };
}

/** The organizations a user owns (real, trial or active) at this moment: a new workstation of theirs works for these. */
export async function ownedOrgIds(db: Queryable, userId: string): Promise<string[]> {
  const list = await rows<{ id: string }>(
    db,
    `SELECT o.id FROM organizations o
      WHERE o.owner_user_id = $1 AND NOT o.simulation AND o.status IN ('trial','active') ORDER BY o.created_at, o.id`,
    [userId],
  );
  return list.map((o) => o.id);
}

/** Whether the workstation has a serving row switched on for the organization (no simulation rule here). */
async function servingOn(db: Queryable, workstationId: string, orgId: string): Promise<boolean> {
  return !!(await one(
    db,
    'SELECT 1 FROM workstation_org_serving WHERE workstation_id=$1 AND org_id=$2 AND serving',
    [workstationId, orgId],
  ));
}

/**
 * A hire onto one's own (real) workstation is the consent [rv 8]: serving turns on for that organization in the same
 * transaction, and the workstation gets the organization's DevOps engineer when the user is an active member. A
 * simulated workstation keeps its own rule and gets nothing.
 */
export async function serveOnHireIn(
  ctx: Pick<Ctx, 'store'>,
  tx: Tx,
  userId: string,
  ws: { id: string; simulation_org_id: string | null; user_id: string },
  orgId: string,
): Promise<void> {
  if (ws.simulation_org_id) return;
  if (await servingOn(tx, ws.id, orgId)) return;
  // A real workstation never serves a simulation organization: nothing to consent to.
  if (await one(tx, 'SELECT 1 FROM organizations WHERE id=$1 AND simulation', [orgId])) return;
  const events: AppendInput[] = [
    servingEvent({ workstationId: ws.id, orgId, serving: true, by: userId, reason: 'hire' }, ws.user_id),
  ];
  if (await activeMember(tx, orgId, ws.user_id)) {
    const dev = await devopsHireEvent(tx, ws.user_id, orgId, ws.id);
    if (dev) events.push(dev);
  }
  events.push(...(await ceoHomeEvents(tx, ws.user_id, ws.id, orgId)));
  await ctx.store.append(events, { tx });
}

/** Switched on for an organization the user owns: its built-in CEO, if it has no home yet, lives here from now on. */
async function ceoHomeEvents(
  tx: Tx,
  ownerId: string,
  workstationId: string,
  orgId: string,
): Promise<AppendInput[]> {
  return (await ceoBindEvents(tx, ownerId, workstationId)).filter(
    (e) => (e.scope as { orgId?: string | null }).orgId === orgId,
  );
}

const activeMember = async (db: Queryable, orgId: string, userId: string): Promise<boolean> =>
  !!(await one(db, `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`, [
    orgId,
    userId,
  ]));

/**
 * Accept (R9): the user's own active real workstations that are to work for the organization. `requested` absent means
 * the default: all of them for a new organization of their own, none for an organization joined as a member.
 */
export async function acceptServingIds(
  db: Queryable,
  userId: string,
  kind: string,
  requested: readonly string[] | undefined,
): Promise<string[]> {
  if (requested === undefined && kind === 'org_member') return [];
  const list = await rows<{ id: string; simulation_org_id: string | null }>(
    db,
    `SELECT id, simulation_org_id FROM workstations
      WHERE user_id=$1 AND status='active' AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      ORDER BY paired_at, id`,
    [userId, requested ? [...new Set(requested)] : null],
  );
  // Every requested id must be an active workstation of the user; a simulated one keeps its own rule and is skipped.
  if (requested && list.length !== new Set(requested).size)
    throw notFound('workstation not found', 'workstation_not_found');
  return list.filter((w) => !w.simulation_org_id).map((w) => w.id);
}

/** The user's workstations still switched on for the organization (from an earlier membership) that are not in `keep`. */
export async function staleServingIds(
  db: Queryable,
  userId: string,
  orgId: string,
  keep: readonly string[],
): Promise<string[]> {
  const list = await rows<{ id: string }>(
    db,
    `SELECT w.id FROM workstations w JOIN workstation_org_serving s ON s.workstation_id = w.id AND s.org_id = $2 AND s.serving
      WHERE w.user_id = $1 AND NOT (w.id = ANY($3::uuid[])) ORDER BY w.paired_at, w.id`,
    [userId, orgId, [...keep]],
  );
  return list.map((w) => w.id);
}

/** `GET /api/workstations/serving`: per active workstation of the user, each organization it may work for. */
export async function listWorkstationServing(
  db: Queryable,
  user: AuthSession['user'],
): Promise<WorkstationServingResponse> {
  const stations = await rows<{ id: string }>(
    db,
    `SELECT id FROM workstations WHERE user_id=$1 AND status='active' AND simulation_org_id IS NULL
      ORDER BY paired_at, id`,
    [user.id],
  );
  // The user's real organizations (member, trial or active), plus any organization a workstation already works for (a guest).
  const orgs = await rows<{
    org_id: string;
    name: string;
    role: string | null;
    ws_id: string;
    serving: boolean;
  }>(
    db,
    `WITH mine AS (
       SELECT o.id AS org_id, o.name, om.role FROM org_members om JOIN organizations o ON o.id = om.org_id
        WHERE om.user_id = $1 AND om.status = 'active' AND NOT o.simulation AND o.status IN ('trial','active')
     )
     SELECT x.org_id, x.name, x.role, w.id AS ws_id, COALESCE(s.serving, false) AS serving
       FROM workstations w
       CROSS JOIN LATERAL (
         SELECT org_id, name, role FROM mine
         UNION
         SELECT o.id, o.name, NULL FROM workstation_org_serving ws2 JOIN organizations o ON o.id = ws2.org_id
          WHERE ws2.workstation_id = w.id AND ws2.serving AND NOT o.simulation
            AND NOT EXISTS (SELECT 1 FROM mine WHERE mine.org_id = o.id)
       ) x
       LEFT JOIN workstation_org_serving s ON s.workstation_id = w.id AND s.org_id = x.org_id
      WHERE w.user_id = $1 AND w.status = 'active' AND w.simulation_org_id IS NULL
      ORDER BY lower(x.name), x.org_id`,
    [user.id],
  );
  return {
    workstations: stations.map((w) => ({
      workstationId: w.id,
      orgs: orgs
        .filter((o) => o.ws_id === w.id)
        .map((o) => ({
          orgId: o.org_id,
          orgName: o.name,
          role: (o.role as 'owner' | 'admin' | 'member' | null) ?? null,
          serving: o.serving === true,
        })),
    })),
  };
}

/**
 * `PUT /api/workstations/:id/orgs/:orgId {serving}`: the workstation's owner only. On: the organization may place agents
 * and DevOps work there; an active member also gets its DevOps engineer. Off: refused while the organization has a
 * running shift there (409 `org_shift_running`); its agents there wait for a new home (`needs_rehome`, the CEO loses its
 * home), its open cards homed there are re-homed, and its DevOps engineer is retired.
 */
export async function setWorkstationServing(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  orgId: string,
  serving: boolean,
): Promise<{ changed: boolean }> {
  const stopped: string[] = [];
  const result = await withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(
      tx,
      `SELECT id, user_id, simulation_org_id FROM workstations WHERE id=$1 AND status='active' FOR UPDATE`,
      [workstationId],
    );
    if (!ws || ws.user_id !== user.id || ws.simulation_org_id) throw notFound('workstation not found');
    const org = await one(tx, 'SELECT id, simulation, status FROM organizations WHERE id=$1', [orgId]);
    const current = await servingOn(tx, workstationId, orgId);
    if (!org || org.simulation) throw notFound('organization not found', 'org_not_found');
    if (current === serving) return { changed: false };
    if (serving) {
      const member = await activeMember(tx, orgId, user.id);
      const guest =
        !member &&
        !!(await one(
          tx,
          `SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id
            WHERE p.org_id=$1 AND pm.user_id=$2 AND pm.status='active' LIMIT 1`,
          [orgId, user.id],
        ));
      if (!member && !guest) throw notFound('organization not found', 'org_not_found');
      if (org.status !== 'trial' && org.status !== 'active')
        throw conflict('org_suspended', 'this organization is not active: it cannot be switched on now');
      const events: AppendInput[] = [
        servingEvent({ workstationId, orgId, serving: true, by: user.id, reason: 'works_for' }, user.id),
      ];
      if (member) {
        const dev = await devopsHireEvent(tx, user.id, orgId, workstationId);
        if (dev) events.push(dev);
      }
      events.push(...(await ceoHomeEvents(tx, user.id, workstationId, orgId)));
      await ctx.store.append(events, { tx });
      return { changed: true };
    }
    const running = await one(
      tx,
      `SELECT 1 FROM shifts WHERE workstation_id=$1 AND org_id=$2 AND status <> 'ended' LIMIT 1`,
      [workstationId, orgId],
    );
    if (running)
      throw conflict(
        'org_shift_running',
        'an agent of this organization is working on this workstation: wait until its shift ends or stop it, then switch it off',
      );
    // Release-readiness O1: the organization's run environments still live on this workstation stop with it (manual,
    // test and DevOps ones alike); restarting them here is refused while it is off (restartRun).
    const live = await rows(
      tx,
      `SELECT * FROM run_environments WHERE workstation_id=$1 AND org_id=$2 AND stop_requested_at IS NULL
        ORDER BY created_at, id FOR UPDATE`,
      [workstationId, orgId],
    );
    for (const r of live.filter((x) => isLiveRunState(x.state))) {
      await requestStopIn(ctx, tx, r, user.id, 'stopped');
      stopped.push(r.id);
    }
    const events: AppendInput[] = [
      servingEvent({ workstationId, orgId, serving: false, by: user.id, reason: 'works_for' }, user.id),
    ];
    const agents = await rows(
      tx,
      `SELECT id, org_id, name, workstation_id, runtime, model, is_devops, is_builtin, role_key FROM agents
        WHERE workstation_id=$1 AND org_id=$2 AND status='active' ORDER BY hired_at, id FOR UPDATE`,
      [workstationId, orgId],
    );
    const actor = userActor(user.id);
    const releasedCards = new Set<string>();
    for (const a of agents.filter((x) => !x.is_devops)) {
      const released = await releaseClaimsOfAgentEvents(
        tx,
        { id: a.id },
        actor,
        `${a.name} lost its workstation: it no longer works for this organization. The card is back in the queue with the last handoff attached.`,
      );
      for (const c of released.cardIds) releasedCards.add(c);
      events.push(...released.events);
      // The built-in CEO is never sent to needs_rehome: it simply has no home until the Owner picks one.
      events.push(
        a.is_builtin && a.role_key === CEO_ROLE_KEY
          ? {
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
              actor,
              scope: orgScope(orgId),
            }
          : {
              streamId: streamId.agent(a.id),
              event: {
                type: 'AgentNeedsRehome',
                payload: {
                  agentId: a.id,
                  by: user.id,
                  fromWorkstationId: workstationId,
                  reason: 'serving_off',
                },
              },
              actor,
              scope: orgScope(orgId),
            },
      );
    }
    // Open cards whose worktree is here cannot continue here: they forget this home and restart from the base branch
    // on any workstation that works for the organization (as when a workstation is retired).
    const homed = await rows(
      tx,
      `SELECT * FROM cards WHERE home_workstation_id=$1 AND org_id=$2 AND status NOT IN ('done','cancelled') ORDER BY ref`,
      [workstationId, orgId],
    );
    for (const c of homed)
      events.push(
        {
          streamId: streamId.card(c.id),
          event: { type: 'CardRehomed', payload: { cardId: c.id, by: user.id } },
          actor,
          scope: projectScope(c.org_id, c.project_id),
        },
        cardMessage(
          c,
          { kind: 'system' },
          'system',
          `The workstation that held this card's work no longer works for this organization: the ${c.stage} stage restarts from the base branch on any workstation.`,
        ),
      );
    events.push(
      ...(await devopsRetireEvents(tx, {
        agents: agents.filter((x) => x.is_devops),
        reason: 'serving_off',
        actor,
        by: user.id,
        skip: { cardIds: releasedCards },
      })),
    );
    await ctx.store.append(events, { tx });
    return { changed: true };
  });
  if (stopped.length) {
    deliver(ctx, [workstationId]);
    for (const id of stopped) ctx.services.browser.runChanged(id);
  }
  return result;
}
