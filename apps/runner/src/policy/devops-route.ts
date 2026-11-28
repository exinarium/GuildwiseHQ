import type { ServerToRunnerOf } from '@aom/shared';
import { isReadOnlyScan } from '../devops/requests.ts';
import { type ApprovedRequest, type ApprovedRequests, c2Resume } from './approved-requests.ts';
import { type DevopsShiftInput, type GateDecision, gateDevopsShift, gateHygiene } from './gate.ts';
import { rebind } from './held.ts';
import type { Policy } from './schema.ts';

type ShiftStartMsg = ServerToRunnerOf<'shift.start'>;

/**
 * quiet-approvals R1-R3: where a DevOps shift from the server runs, decided locally and kept pure (every rule is a unit
 * test). The server can ask, never choose: nothing here reads a server field as a grant.
 *
 * - no local grant: refused (unchanged);
 * - a read-only scan: runs as today in its own read-only sandbox (stricter than the box), no hold;
 * - a hygiene request: the fixed routine (`gateHygiene`: run, or one local yes);
 * - a conflict request (C3): one local yes, as today; release prep: exactly as before;
 * - an exact job approved locally (R2; under a new request id only through the B1 guard), or its resume within C2:
 *   outside the box, no hold;
 * - the box cannot start on this computer: one local yes (fail closed: never outside without it);
 * - everything else: inside the box, no hold.
 */
export type DevopsRoute =
  | { route: 'refuse'; reason: string }
  /** Not a DevOps request shift (release prep): runs exactly as before this change (its own guard). */
  | { route: 'asBefore' }
  | { route: 'scan' }
  | { route: 'hygiene'; decision: GateDecision }
  /**
   * `msg` is what runs: for R2 the APPROVED body with only the new ids (`rebind`); for C2 the runner's rendering.
   * `adopt`: an R2 match under a new request id (B1 passed): the runner gives that request its own entry.
   */
  | { route: 'outside'; why: 'r2' | 'c2'; msg: ShiftStartMsg; key: string; adopt?: ApprovedRequest }
  | { route: 'box' }
  | { route: 'hold'; decision: Extract<GateDecision, { action: 'hold' }> };

export interface RouteDeps {
  granted: boolean;
  approved?: Pick<ApprovedRequests, 'match' | 'ofRequest'>;
  /** Why the box cannot start here (no bwrap, not Claude Code, ...); null when it can. */
  boxMissing: string | null;
  /**
   * Rework 1 (REVIEW S4): the runtime builds the box but cannot here (old or missing bubblewrap, no model credential):
   * an approved run would fail the same way, so the request is refused with that reason (never a hold that fails after
   * the yes). Absent or false: the runtime has no box at all, and the held request runs as before after a yes.
   */
  boxBroken?: boolean;
  /**
   * e2e-found-fixes B1: may an exact job approved under ANOTHER request run outside under this request id? The runner
   * answers: not refused here, first sight of the request, and a request folder it could create new (that claim is made
   * only when everything else already passed, so it is asked last). Absent: never (the job goes into the box).
   */
  crossRequestOk?: (requestId: string, agentId: string) => boolean;
}

/**
 * gate-fixes-1 F3: a DevOps REQUEST shift (not release prep, not a read-only scan, not the hygiene routine). It runs in the
 * box the runner builds, and outside it only in the outer box, where Docker is reached only through the runner's filtering
 * gatekeeper: its access is narrowed in `proxy` mode (the server switch AND the local ceiling), once, at the runner's entry.
 */
export const isRequestShift = (msg: ShiftStartMsg): boolean =>
  msg.kind === 'devops' && !isReadOnlyScan(msg) && !msg.devops?.hygiene;

export function devopsShiftInput(msg: ShiftStartMsg): DevopsShiftInput {
  return {
    orgId: msg.orgId ?? '',
    agentId: msg.agent.agentId,
    agentName: msg.agent.name,
    shiftId: msg.shiftId,
    ...(msg.devops?.summary
      ? { request: msg.devops.summary, cardTitle: msg.devops.summary.slice(0, 120) }
      : {}),
    ...(msg.devops?.requestedBy?.name ? { requester: msg.devops.requestedBy.name } : {}),
    kind: msg.kind,
    ...(msg.devops?.access ? { access: msg.devops.access } : {}),
    ...(msg.devops?.approval?.commands?.length ? { approvedCommands: msg.devops.approval.commands } : {}),
    ...(isRequestShift(msg) ? { docker: 'proxy' as const } : {}),
  };
}

/** A held decision for a DevOps shift (the classic `devops.task` text), whatever `devopsRequests` says. */
function heldTask(
  policy: Policy,
  msg: ShiftStartMsg,
  granted: boolean,
  note: string,
): Extract<GateDecision, { action: 'hold' }> | { action: 'refuse'; reason: string } {
  const d = gateDevopsShift({ ...policy, devopsRequests: 'ask' }, devopsShiftInput(msg), granted);
  if (d.action === 'refuse') return d;
  if (d.action !== 'hold') throw new Error('unreachable');
  return { ...d, detail: `${d.detail}\n\n${note}`, note: d.note ?? note.slice(0, 300) };
}

export function routeDevopsShift(policy: Policy, msg: ShiftStartMsg, deps: RouteDeps): DevopsRoute {
  const input = devopsShiftInput(msg);
  const base = gateDevopsShift(policy, input, deps.granted);
  if (base.action === 'refuse') return { route: 'refuse', reason: base.reason };
  // only DevOps request shifts are boxed; release prep keeps its own guard and local yes
  if (msg.kind !== 'devops')
    return base.action === 'hold' ? { route: 'hold', decision: base } : { route: 'asBefore' };
  if (isReadOnlyScan(msg)) return { route: 'scan' };
  const hygiene = msg.devops?.hygiene;
  if (hygiene)
    return {
      route: 'hygiene',
      decision: gateHygiene(policy, {
        orgId: input.orgId,
        agentId: input.agentId,
        ...(input.agentName ? { agentName: input.agentName } : {}),
        shiftId: msg.shiftId,
        repos: hygiene.repos.map((r) => r.name),
      }),
    };
  if (deps.boxMissing && deps.boxBroken) return { route: 'refuse', reason: boxBrokenText(deps.boxMissing) };
  // C3 closed by S7: conflict work runs in the box, in a scratch clone the runner makes; the runner moves the branch
  if ((msg.devops?.conflictCard || msg.devops?.conflictRepo) && deps.boxMissing) {
    const d = heldTask(
      policy,
      msg,
      deps.granted,
      `The safety box cannot start on this computer (${deps.boxMissing}): approving runs this conflict work outside it.`,
    );
    return d.action === 'refuse' ? { route: 'refuse', reason: d.reason } : { route: 'hold', decision: d };
  }
  // R2: exactly the job the owner approved on this computer, run as approved (only the ids are new)
  const requestId = msg.devops?.requestId;
  const exact = deps.approved?.match(msg);
  const bound = exact ? rebind(exact.body, msg) : null;
  if (exact && bound && requestId) {
    if (exact.requestId === requestId)
      return { route: 'outside', why: 'r2', msg: bound as ShiftStartMsg, key: exact.key };
    // B1: the request id picks the request folder, its temp folder and environment ownership: a new one only when fresh
    if (deps.crossRequestOk?.(requestId, msg.agent.agentId) === true)
      return { route: 'outside', why: 'r2', msg: bound as ShiftStartMsg, key: exact.key, adopt: exact };
  }
  // C2: the resume of an approved job, within the allowed differences, for commands its session asked for
  if (requestId && msg.devops?.approval?.commands?.length)
    for (const e of [...(deps.approved?.ofRequest(requestId) ?? [])].reverse()) {
      const r = c2Resume(e, msg);
      if (r.ok) return { route: 'outside', why: 'c2', msg: r.body as ShiftStartMsg, key: e.key };
    }
  if (deps.boxMissing) {
    const d = heldTask(
      policy,
      msg,
      deps.granted,
      `The safety box cannot start on this computer (${deps.boxMissing}): approving runs this request outside it.`,
    );
    return d.action === 'refuse' ? { route: 'refuse', reason: d.reason } : { route: 'hold', decision: d };
  }
  return { route: 'box' };
}

/** REVIEW S4: what the owner reads when DevOps cannot work on this computer yet (friendly, with the way to fix it). */
export function boxBrokenText(reason: string): string {
  return `DevOps cannot work on this computer yet: ${reason}. Nothing was run. Fix it on the computer, then run \`guildwise-runner setup\` again; the request can be sent again after that.`;
}
