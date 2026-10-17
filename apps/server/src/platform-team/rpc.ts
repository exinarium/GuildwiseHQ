import { TriageBugRequestSchema } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { platformOwner, triageBug } from './intake.ts';
import { getPlatformTeam } from './settings.ts';

/**
 * `platform.triage` RPC (`aom bug triage`): the platform architect closes the bug card of its shift as invalid, or sets
 * the severity and fix size. Only an architect of the platform organisation, only on a platform bug card.
 */
export async function platformTriageRpc(
  ctx: Ctx,
  shift: Row,
  params: Record<string, unknown>,
): Promise<[boolean, unknown, string | undefined]> {
  const usage =
    'usage: aom bug triage --invalid --reason "<why>"  |  aom bug triage --severity critical|degraded|minor [--size small|medium|large] [--reason "<one line>"]';
  const team = await getPlatformTeam(ctx.pool);
  if (!team) return [false, undefined, 'no platform team is designated'];
  const agent = await one(ctx.pool, 'SELECT id, name, role_key, org_id FROM agents WHERE id=$1', [shift.agent_id]);
  if (!agent || agent.role_key !== 'architect' || agent.org_id !== team.orgId)
    return [false, undefined, 'only the platform architect can triage platform bugs'];
  if (!shift.card_id) return [false, undefined, 'triage works on the bug card of your shift'];
  const parsed = TriageBugRequestSchema.safeParse({
    verdict: params.invalid ? 'invalid' : 'valid',
    ...(params.severity ? { severity: String(params.severity) } : {}),
    ...(params.size ? { size: String(params.size) } : {}),
    ...(params.reason ? { reason: String(params.reason) } : {}),
  });
  if (!parsed.success) return [false, undefined, `${parsed.error.issues.map((i) => i.message).join('; ')}. ${usage}`];
  const ownerId = await platformOwner(ctx.pool, team);
  if (!ownerId) return [false, undefined, 'the platform project has no owner'];
  try {
    const r = await triageBug(
      ctx,
      { userId: ownerId, label: `the platform architect (${agent.name})`, asAgentId: agent.id },
      shift.card_id,
      parsed.data,
    );
    return [
      true,
      {
        ...r,
        message:
          r.status === 'invalid'
            ? 'Closed as invalid. Finish now.'
            : `Triaged: severity ${r.severity}. Design the fix and hand it on as usual.${r.severity === 'critical' ? ' The affected scope is paused until the fix is done.' : ''}`,
      },
      undefined,
    ];
  } catch (err) {
    return [false, undefined, (err as Error).message];
  }
}
