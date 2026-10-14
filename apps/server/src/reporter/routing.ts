import {
  DESK_SUBKIND,
  type DomainEvent,
  REPORTER,
  ROUTING_EXEMPT_SUBKINDS,
  topicWords,
  WORKING_BRANCH_SUBKIND,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { ceoActive, ceoReachable } from '../ceo/state.ts';
import { reportingOf } from './settings.ts';
import { baAvailable, enqueueReporterTask } from './tasks.ts';

/** The same approval asked again: this many earlier similar ones in the window (the detector counts the third as a repeat). */
async function isRepeatedApproval(
  tx: Tx,
  orgId: string,
  p: { subkind?: string | undefined; title: string },
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - REPORTER.repeatedApproval.windowHours * 3600_000);
  const strip = (t: string) => t.replace(/^DevOps needs approval:\s*/i, '');
  const words = new Set(topicWords(strip(p.title)));
  const prior = await rows(
    tx,
    `SELECT title FROM desk_items WHERE org_id=$1 AND kind='approval' AND subkind IS NOT DISTINCT FROM $2
        AND created_at > $3 AND triage <> 'pending'`,
    [orgId, p.subkind ?? null, since],
  );
  const similar = prior.filter((r) => {
    const w = new Set(topicWords(strip(String(r.title))));
    if (words.size === 0 || w.size === 0) return r.title === p.title;
    let shared = 0;
    for (const x of words) if (w.has(x)) shared++;
    return shared / Math.min(words.size, w.size) >= REPORTER.repeatedApproval.similarity;
  });
  return similar.length >= REPORTER.repeatedApproval.count - 1;
}

/**
 * Part B routing (owner decisions B2/B3): every agent-raised desk item goes through the BA first.
 *
 * - Urgent items (approvals, escalations, pinned alerts) reach the manager at once, unchanged. Blocking questions walk
 *   the escalation chain first (senior peer, then the BA, then the manager; `commands/escalation.ts`). The BA adds a
 *   note (`urgent_note` task) only where it adds value (owner decision, 2026-10-06): an escalation (a question that
 *   went up the chain to the manager, or an escalation item), a repeated approval, and loops (the loop breaker's alert,
 *   analysed by its own signal task). A plain approval gets none.
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
    if (
      !inputs.some(
        (i) =>
          i.event.type === 'DeskItemCreated' ||
          i.event.type === 'QuestionRaised' ||
          i.event.type === 'QuestionEscalated',
      )
    )
      return inputs;
    const now = ctx.clock.now();
    // Who looks at held and urgent items: the CEO when one is active and reachable (it replaces the BA's reporter job,
    // docs/design/ceo-agent-v2.md D3), else the BA, else nobody (items reach the manager unchanged).
    const cache = new Map<string, 'ceo' | 'ba' | null>();
    const who = async (orgId: string, projectId: string | null): Promise<'ceo' | 'ba' | null> => {
      const key = `${orgId}|${projectId ?? ''}`;
      if (!cache.has(key)) {
        const prefs = await reportingOf(tx, orgId);
        let v: 'ceo' | 'ba' | null = null;
        if (prefs.routeViaBa) {
          if ((await ceoActive(tx, orgId)) && (await ceoReachable(tx, orgId, now)).ok) v = 'ceo';
          else if (await baAvailable(tx, orgId, projectId, now)) v = 'ba';
        }
        cache.set(key, v);
      }
      return cache.get(key) ?? null;
    };
    const active = async (orgId: string, projectId: string | null): Promise<boolean> => (await who(orgId, projectId)) !== null;
    const byBa = async (orgId: string, projectId: string | null): Promise<boolean> => (await who(orgId, projectId)) === 'ba';
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
          // The loop breaker's alert is analysed by the loop signal (`floor_alert`) instead of a note task. Plain
          // approvals and pinned alerts get no note; escalations and repeated approvals do.
          if (
            !loop &&
            (p.kind === 'escalation' ||
              (p.kind === 'approval' && (await isRepeatedApproval(tx, orgId, p, now))))
          )
            if (await byBa(orgId, projectId)) add(noted, orgId, projectId, p.deskItemId);
          out.push(input);
        } else {
          const deadline = new Date(now.getTime() + REPORTER.triageWindowMinutes * 60_000).toISOString();
          out.push({ ...input, event: { ...ev, payload: { ...p, triage: { deadline } } } });
          if (await byBa(orgId, projectId)) add(held, orgId, projectId, p.deskItemId);
        }
        continue;
      }
      if (ev.type === 'QuestionRaised') {
        const p = ev.payload;
        const subkind = p.subkind ?? '';
        const projectId = p.projectId ?? input.scope.projectId;
        // The DevOps engineer's working-branch question is a non-urgent item unless it holds back a commit: held for
        // the BA's triage like other non-urgent items (it may answer from the ledger or pass it on).
        if (
          subkind === WORKING_BRANCH_SUBKIND &&
          !p.blocking &&
          p.routedTo === 'manager' &&
          p.askedBy.kind === 'agent' &&
          (await active(orgId, projectId))
        ) {
          const deadline = new Date(now.getTime() + REPORTER.triageWindowMinutes * 60_000).toISOString();
          out.push({ ...input, event: { ...ev, payload: { ...p, triage: { deadline } } } });
          if (await byBa(orgId, projectId)) add(held, orgId, projectId, p.deskItemId);
          continue;
        }
      }
      if (ev.type === 'QuestionEscalated') {
        // A question that went up the chain and now reaches the manager's desk: the BA adds context (unless the BA
        // itself passed it on, whose reasoning is already in the trail).
        const p = ev.payload;
        if (p.routedTo === 'manager' && (await byBa(orgId, null))) {
          const by = p.fromAgentId
            ? await one<{ role_key: string }>(tx, 'SELECT role_key FROM agents WHERE id=$1', [p.fromAgentId])
            : undefined;
          if (by?.role_key !== 'ba') {
            const item = await one<{ project_id: string | null }>(
              tx,
              'SELECT project_id FROM desk_items WHERE id=$1',
              [p.deskItemId],
            );
            add(noted, orgId, item?.project_id ?? input.scope.projectId, p.deskItemId);
          }
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
