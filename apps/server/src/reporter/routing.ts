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
import { reportingOf } from './settings.ts';
import { baAvailable, enqueueReporterTask } from './tasks.ts';

/**
 * Part B routing (owner decisions B2/B3): every agent-raised desk item goes through the BA first.
 *
 * - Urgent items (blocking questions, approvals, escalations, pinned alerts) reach the manager at once, unchanged. The
 *   BA adds a note afterwards (`urgent_note` task).
 * - Everything else (non-pinned alerts) is held, hidden from the desk, for the BA's triage (`desk_triage` task). The
 *   hold ends when the BA decides or at the deadline (`REPORTER.triageWindowMinutes`), whichever comes first: the BA
 *   never blocks anything. The reporter sweep releases expired holds.
 * - No BA reachable, or the organization turned routing off: nothing is held and nothing is noted.
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
    const active = async (orgId: string, projectId: string | null): Promise<boolean> => {
      const key = `${orgId}|${projectId ?? ''}`;
      if (!cache.has(key)) {
        const prefs = await reportingOf(tx, orgId);
        cache.set(key, prefs.routeViaBa && (await baAvailable(tx, orgId, projectId, now)));
      }
      return cache.get(key) as boolean;
    };
    const held = new Map<string, { orgId: string; projectId: string | null; ids: string[] }>();
    const noted = new Map<string, { orgId: string; projectId: string | null; ids: string[] }>();
    const add = (m: typeof held, orgId: string, projectId: string | null, id: string): void => {
      const key = `${orgId}|${projectId ?? ''}`;
      const cur = m.get(key) ?? { orgId, projectId, ids: [] };
      cur.ids.push(id);
      m.set(key, cur);
    };

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
        if (p.kind === 'rating' || ROUTING_EXEMPT_SUBKINDS.includes(subkind)) {
          out.push(input);
          continue;
        }
        const projectId = p.projectId ?? input.scope.projectId;
        if (!(await active(orgId, projectId))) {
          out.push(input);
          continue;
        }
        // A shift loop burns tokens while it runs (owner decision B1): its alert is never held.
        const loop = subkind === DESK_SUBKIND.loopBackoff;
        const urgent = p.blocking || p.pinned || p.kind !== 'alert' || loop;
        if (urgent) {
          // The loop breaker's alert is analysed by the loop signal (`floor_alert`) instead of a note task.
          if (!loop) add(noted, orgId, projectId, p.deskItemId);
          out.push(input);
        } else {
          const deadline = new Date(now.getTime() + REPORTER.triageWindowMinutes * 60_000).toISOString();
          out.push({ ...input, event: { ...ev, payload: { ...p, triage: { deadline } } } });
          add(held, orgId, projectId, p.deskItemId);
        }
        continue;
      }
      if (ev.type === 'QuestionRaised') {
        const p = ev.payload;
        const subkind = p.subkind ?? '';
        const projectId = p.projectId ?? input.scope.projectId;
        if (
          p.blocking &&
          p.routedTo === 'manager' &&
          p.askedBy.kind === 'agent' &&
          !ROUTING_EXEMPT_SUBKINDS.includes(subkind) &&
          (await active(orgId, projectId))
        )
          add(noted, orgId, projectId, p.deskItemId);
        // The DevOps engineer's working-branch question is a non-urgent item unless it holds back a commit: held for
        // the BA's triage like other non-urgent items (it may answer from the ledger or pass it on).
        else if (
          subkind === WORKING_BRANCH_SUBKIND &&
          !p.blocking &&
          p.routedTo === 'manager' &&
          p.askedBy.kind === 'agent' &&
          (await active(orgId, projectId))
        ) {
          const deadline = new Date(now.getTime() + REPORTER.triageWindowMinutes * 60_000).toISOString();
          out.push({ ...input, event: { ...ev, payload: { ...p, triage: { deadline } } } });
          add(held, orgId, projectId, p.deskItemId);
          continue;
        }
      }
      out.push(input);
    }
    for (const g of held.values())
      out.push(
        ...(await enqueueReporterTask(tx, {
          orgId: g.orgId,
          projectId: g.projectId,
          kind: 'desk_triage',
          deskItemIds: g.ids,
        })),
      );
    for (const g of noted.values())
      out.push(
        ...(await enqueueReporterTask(tx, {
          orgId: g.orgId,
          projectId: g.projectId,
          kind: 'urgent_note',
          deskItemIds: g.ids,
        })),
      );
    return out;
  };
}
