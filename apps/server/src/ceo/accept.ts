import type { Row } from '../db/sql.ts';
import { one } from '../db/sql.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { makeEnv, ownerPrincipal, runAction, type EngineResult } from './engine.ts';
import { recordResponse } from './learning.ts';
import { notifyOwner } from './notify.ts';
import { loadCeo } from './state.ts';

/**
 * The owner pressed "Do it" on a recommendation of the CEO: the stored action runs with the owner's say-so (the policy
 * is the owner's own decision here), recorded as a new action that points back at the recommendation, and the response
 * is the training observation "accepted". When the world moved on (the card is gone, the agent was fired), the owner
 * is told on the desk instead of being left wondering.
 */
export async function acceptRecommendation(ctx: Ctx, user: AuthSession['user'], item: Row): Promise<EngineResult | undefined> {
  const actionId = item.data?.actionId as string | undefined;
  if (!actionId) return undefined;
  const a = await one(ctx.pool, `SELECT * FROM ceo_actions WHERE id=$1 AND org_id=$2 AND mode='recommended'`, [actionId, item.org_id]);
  const ceo = await loadCeo(ctx.pool, item.org_id);
  if (!a || !ceo?.agentId) return undefined;
  const agent = await one(ctx.pool, 'SELECT id, name FROM agents WHERE id=$1', [ceo.agentId]);
  if (!agent) return undefined;
  const owner = await ownerPrincipal(ctx, item.org_id);
  const origin = { scopeId: actionId, untrusted: false, acceptedFrom: actionId };
  const env = makeEnv(ctx, ceo, agent as { id: string; name: string }, owner, origin);
  const r = await runAction(
    env,
    {
      op: 'act',
      action: a.action as never,
      params: a.params ?? {},
      reason: a.reason,
      confidence: Number(a.confidence),
      evidence: a.evidence ?? [],
      key: `accept:${actionId}`,
      dryRun: false,
    },
    origin,
    { force: true },
  );
  await recordResponse(ctx, item.org_id, user.id, actionId, 'accepted', { deskItemId: item.id });
  if (r.status === 'refused')
    await notifyOwner(ctx, item.org_id, {
      kind: 'needs_you',
      title: 'Could not do what you accepted',
      text: `You accepted "${String(a.subject_label).slice(0, 120)}", but it could not be done any more: ${r.message}`,
      subject: `accept:${actionId}`,
    });
  return r;
}

export async function rejectRecommendation(ctx: Ctx, user: AuthSession['user'], item: Row, note?: string): Promise<void> {
  const actionId = item.data?.actionId as string | undefined;
  if (!actionId) return;
  await recordResponse(ctx, item.org_id, user.id, actionId, 'rejected', { deskItemId: item.id, note });
}
