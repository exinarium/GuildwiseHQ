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
    const ack = await sandboxGate(ctx, tx, user.id, ws.id, a.runtime, req.acknowledgeUnsandboxed, {
      roleKey: 'ceo',
      model: a.model,
    });
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

/**
 * "Clear" (the owner's new chat): the standing chat becomes a fresh thread and the earlier one is archived for the owner,
 * so it moves under "Earlier" (nothing is deleted; it can still be read, restored and continued). Refused with 409
 * `turn_in_flight` while a turn of the current thread is running (a queued one does not block). Idempotent while the
 * current thread has no messages: that thread is returned.
 */
export async function newCeoChatThread(ctx: Ctx, user: AuthSession['user'], orgId: string): Promise<string> {
  if (!(await isOrgOwner(ctx.pool, user.id, orgId)))
    throw forbidden('only the organization Owner can talk to the CEO');
  return withAppendTx(ctx.pool, async (tx) => {
    const ceo = await loadCeo(tx, orgId);
    const previous = ceo?.chatThreadId ?? null;
    if (previous) {
      // Nothing said yet: the standing chat already is a fresh one (double taps and two tabs do not pile up threads).
      const used = await one(tx, 'SELECT 1 FROM thread_messages WHERE thread_id=$1 LIMIT 1', [previous]);
      if (!used) return previous;
      // A reply being produced would be orphaned by the switch. A QUEUED turn (the workstation is offline) does not
      // block: it stays in the earlier thread and is delivered there when the workstation is back.
      const turn = await one(tx, `SELECT 1 FROM ceo_turns WHERE thread_id=$1 AND status='running' LIMIT 1`, [
        previous,
      ]);
      if (turn || ctx.services.chat.isBusy(previous))
        throw conflict('turn_in_flight', 'the CEO is answering: wait for the reply, then start a new chat');
    }
    const t = await ensureCeoThread(tx, orgId, { fresh: true });
    if (!t.threadId) throw conflict('no_ceo', 'there is no CEO');
    const events = [...t.events];
    if (previous && previous !== t.threadId) {
      const old = await one(
        tx,
        `SELECT t.org_id, t.project_id FROM threads t
          WHERE t.id=$1 AND t.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM chat_archives x WHERE x.thread_id=t.id AND x.user_id=$2)`,
        [previous, user.id],
      );
      if (old)
        events.push({
          streamId: streamId.thread(previous),
          event: { type: 'ChatArchived', payload: { threadId: previous, userId: user.id } },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        });
    }
    await ctx.store.append(events, { tx });
    return t.threadId;
  });
}
