import { streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { sandboxGate } from '../commands/agents.ts';
import { orgScope, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { ensureCeoThread } from './chat.ts';
import { isOrgOwner } from './commands.ts';
import { loadCeo } from './state.ts';

/** The CEO moves to another of the owner's workstations (its home; no automatic failover). */
export async function moveCeo(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  req: { workstationId: string; acknowledgeUnsandboxed?: boolean | undefined },
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    if (!(await isOrgOwner(tx, user.id, orgId))) throw forbidden('only the organization Owner can do this');
    const ceo = await loadCeo(tx, orgId);
    if (!ceo?.enabled || !ceo.agentId) throw conflict('no_ceo', 'there is no CEO');
    const running = await one(tx, `SELECT 1 FROM shifts WHERE agent_id=$1 AND status <> 'ended' LIMIT 1`, [
      ceo.agentId,
    ]);
    if (running) throw conflict('ceo_busy', 'the CEO is working right now: try again in a minute');
    const a = await one(tx, 'SELECT * FROM agents WHERE id=$1', [ceo.agentId]);
    const ws = await one(
      tx,
      `SELECT id FROM workstations WHERE id=$1 AND status='active' AND (user_id=$2 OR simulation_org_id=$3)`,
      [req.workstationId, user.id, orgId],
    );
    if (!a || !ws) throw notFound('workstation not found: the CEO runs on your own workstation');
    if (a.workstation_id === ws.id) return;
    const ack = await sandboxGate(ctx, tx, user.id, ws.id, a.runtime, req.acknowledgeUnsandboxed);
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(a.id),
          event: {
            type: 'AgentRehomed',
            payload: {
              agentId: a.id,
              workstationId: ws.id,
              runtime: a.runtime,
              model: a.model,
              ...(ack ? { unsandboxedAck: ack } : {}),
            },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
}

/** The owner's standing chat with the CEO: found or created. */
export async function ceoChatThread(ctx: Ctx, user: AuthSession['user'], orgId: string): Promise<string> {
  if (!(await isOrgOwner(ctx.pool, user.id, orgId)))
    throw forbidden('only the organization Owner can talk to the CEO');
  return withAppendTx(ctx.pool, async (tx) => {
    const t = await ensureCeoThread(tx, orgId);
    if (!t.threadId) throw conflict('no_ceo', 'there is no CEO');
    if (t.events.length) await ctx.store.append(t.events, { tx });
    return t.threadId;
  });
}
