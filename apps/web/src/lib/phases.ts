import type { FollowupSpec, PhaseFollowupDto, PhaseStatus } from '@aom/shared';

/** A follow-up row as the editor's spec (what a PUT sends back). */
export function specOf(d: PhaseFollowupDto): FollowupSpec {
  if (d.kind === 'deploy') return { id: d.id, kind: 'deploy', targetId: d.targetId ?? '', note: d.note };
  if (d.kind === 'regression')
    return {
      id: d.id,
      kind: 'regression',
      platform: (d.platform ?? 'web') as 'web' | 'mobile' | 'both',
      ...(d.targetId ? { targetId: d.targetId } : {}),
      note: d.note,
    };
  return { id: d.id, kind: 'custom', instruction: d.instruction, note: d.note };
}

/** Specs without ids (a new phase or the project's defaults mint their own). */
export const withoutIds = (list: FollowupSpec[]): FollowupSpec[] =>
  list.map(({ id: _id, ...rest }) => rest as FollowupSpec);

export const PHASE_STATUS_LABEL: Record<PhaseStatus, string> = {
  proposed: 'Proposed',
  open: 'Open',
  reporting: 'Writing the report',
  awaiting_approval: 'Waiting for your approval',
  running_followups: 'Running follow-ups',
  reporting_results: 'Writing the results',
  done: 'Done',
  done_with_failures: 'Done, with failures',
  followups_rejected: 'Follow-ups rejected',
  discarded: 'Discarded',
  cancelled: 'Cancelled',
};

export function phaseTone(status: PhaseStatus): 'neutral' | 'red' | 'amber' | 'green' | 'blue' | 'violet' {
  if (status === 'done') return 'green';
  if (status === 'done_with_failures') return 'red';
  if (status === 'awaiting_approval' || status === 'proposed') return 'amber';
  if (status === 'running_followups' || status === 'reporting_results' || status === 'reporting')
    return 'blue';
  return 'neutral';
}

/** `/p/WEB/phases/2` from a ref like `WEB-P2`. */
export function phasePath(ref: string): string {
  const m = /^(.+)-P(\d+)$/.exec(ref);
  return m ? `/p/${m[1]}/phases/${m[2]}` : '/projects';
}

export const OUTCOME_LABEL = {
  finalized: 'finalized',
  closed_manually: 'closed by hand',
  cancelled: 'cancelled',
  waiting_merge: 'waiting to be merged',
} as const;
