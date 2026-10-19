import { createHash } from 'node:crypto';
import { CEO_DEGRADED_FULL_POWER_OFF, type CeoOrderSpec } from '@aom/shared';

/**
 * Which profile a chat turn runs in (docs/design/ceo-front-door.md section 3.2). The SERVER decides the provenance
 * (`ceoMode`); the runner never upgrades a turn on its own say, and holds the machine owner's local opt-in against any
 * server. Pure; unit tested.
 *
 * - `restricted`: today's behaviour (not a CEO owner turn, or `ceoMode` is absent, or the agent is not the CEO).
 * - `full`: the owner's own Claude Code (`ceoMode` owner or order, CEO agent, opt-in on).
 * - `degraded`: an owner turn without the opt-in runs restricted and reports `chat.done.degraded`.
 * - `refuse`: an order turn that lacks the opt-in or an Owner-marked, hash-matching authorization.
 */
export type ChatProfile =
  | { kind: 'restricted' }
  | { kind: 'full'; mode: 'owner' | 'order' }
  | { kind: 'degraded'; degraded: typeof CEO_DEGRADED_FULL_POWER_OFF }
  | { kind: 'refuse'; error: 'full_power_off' | 'order_not_authorized' };

export const orderVersionHash = (title: string, body: string): string =>
  createHash('sha256').update(`${title}\n${body}`).digest('hex');

/** The order's authorization holds: the Owner marked it and the wording still hashes to what he marked. */
export function orderAuthorized(order: CeoOrderSpec | undefined): boolean {
  return (
    !!order && order.ownerMarked === true && orderVersionHash(order.title, order.body) === order.versionHash
  );
}

export function selectChatProfile(
  msg: {
    ceoMode?: 'owner' | 'order' | undefined;
    agent: { roleKey: string };
    order?: CeoOrderSpec | undefined;
  },
  local: { fullPower: boolean },
): ChatProfile {
  if (!msg.ceoMode || msg.agent.roleKey !== 'ceo') return { kind: 'restricted' };
  if (msg.ceoMode === 'order') {
    if (!orderAuthorized(msg.order)) return { kind: 'refuse', error: 'order_not_authorized' };
    if (!local.fullPower) return { kind: 'refuse', error: 'full_power_off' };
    return { kind: 'full', mode: 'order' };
  }
  if (!local.fullPower) return { kind: 'degraded', degraded: CEO_DEGRADED_FULL_POWER_OFF };
  return { kind: 'full', mode: 'owner' };
}

/** A shift (a wake, any kind) never gets the owner builder, whatever its payload says. */
export const shiftProfile = (): ChatProfile => ({ kind: 'restricted' });
