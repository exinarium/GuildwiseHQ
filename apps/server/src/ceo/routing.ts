import {
  DESK_SUBKIND,
  type DomainEvent,
  REPORTER,
  ROUTING_EXEMPT_SUBKINDS,
  WORKING_BRANCH_SUBKIND,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { ceoActive, ceoReachable } from './state.ts';

/**
 * Desk routing (docs/design/ceo-front-door.md step 3, replacing the BA reporter's routing of Part B): non-urgent items
 * are held, hidden from the desk, for the CEO's triage (it is woken by the item). The hold ends when the CEO decides or at
 * the deadline (`REPORTER.triageWindowMinutes`), whichever comes first: the CEO never blocks anything, and the sweep
 * (`ceo/signals.ts`) releases expired holds. Urgent items (approvals, escalations, pinned or blocking items, the loop
 * breaker's alert) reach the owner at once, unchanged.
 *
 * Only a CEO that is active (not paused) and reachable holds items: an offline CEO or a paused one holds nothing, so
 * the owner sees everything unchanged. There is no BA fallback any more and no per-organization switch.
 *
 * It runs inside the append transaction of every `DeskItemCreated` / `QuestionRaised` (the event store's interceptor
 * hook), so every emitter is covered and the decision is recorded in the event (`triage`), never recomputed on replay.
 */
export function createRoutingInterceptor(ctx: Ctx) {
  return async (tx: Tx, inputs: AppendInput[]): Promise<AppendInput[]> => {
    if (!inputs.some((i) => i.event.type === 'DeskItemCreated' || i.event.type === 'QuestionRaised'))
      return inputs;
    const now = ctx.clock.now();
    const cache = new Map<string, boolean>();
    const ceoHolds = async (orgId: string): Promise<boolean> => {
      if (!cache.has(orgId))
        cache.set(orgId, !!(await ceoActive(tx, orgId)) && (await ceoReachable(tx, orgId, now)).ok);
      return cache.get(orgId) === true;
    };
    const deadline = () => new Date(now.getTime() + REPORTER.triageWindowMinutes * 60_000).toISOString();

    const out: AppendInput[] = [];
    for (const input of inputs) {
      const ev = input.event as DomainEvent;
      const orgId = input.scope.orgId;
      if (!orgId) {
        out.push(input);
        continue;
      }
      if (ev.type === 'DeskItemCreated') {
        const p = ev.payload;
        const subkind = p.subkind ?? '';
        if (p.kind === 'rating' || ROUTING_EXEMPT_SUBKINDS.includes(subkind) || !(await ceoHolds(orgId))) {
          out.push(input);
          continue;
        }
        // A shift loop burns tokens while it runs (owner decision B1): its alert is never held.
        const loop = subkind === DESK_SUBKIND.loopBackoff;
        const urgent = p.blocking || p.pinned || p.kind !== 'alert' || loop;
        if (urgent) out.push(input);
        else out.push({ ...input, event: { ...ev, payload: { ...p, triage: { deadline: deadline() } } } });
        continue;
      }
      if (ev.type === 'QuestionRaised') {
        const p = ev.payload;
        // The DevOps engineer's working-branch question is a non-urgent item unless it holds back a commit: held for
        // the CEO's triage like other non-urgent items (it may answer from the ledger or pass it on).
        if (
          (p.subkind ?? '') === WORKING_BRANCH_SUBKIND &&
          !p.blocking &&
          p.routedTo === 'manager' &&
          p.askedBy.kind === 'agent' &&
          (await ceoHolds(orgId))
        ) {
          out.push({ ...input, event: { ...ev, payload: { ...p, triage: { deadline: deadline() } } } });
          continue;
        }
      }
      out.push(input);
    }
    return out;
  };
}
