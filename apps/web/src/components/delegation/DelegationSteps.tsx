import type { DelegationStepDto } from '@aom/shared';
import { Badge } from '../ui.tsx';
import { profileText } from './DelegateGrants.tsx';

export const formatMs = (ms: number | null): string =>
  ms === null
    ? ''
    : ms < 1000
      ? `${ms} ms`
      : ms < 60_000
        ? `${(ms / 1000).toFixed(1)} s`
        : `${Math.round(ms / 60_000)} min`;
export const formatCostUsd = (d: Pick<DelegationStepDto, 'costUsd' | 'costUnknown'>): string =>
  d.costUnknown || d.costUsd === null ? 'cost unknown' : `$${d.costUsd.toFixed(d.costUsd < 0.01 ? 4 : 2)}`;

/**
 * One delegation as a sub-step: who did it, on which model, with which tools, how long it took, what it cost and what came
 * back. Failures say so. A Claude Code subagent is marked.
 */
export function DelegationStep({ d }: { d: DelegationStepDto }) {
  const failed = d.outcome !== 'ok';
  return (
    <div
      data-testid="delegation-step"
      data-outcome={d.outcome}
      className="flex flex-col gap-0.5 border-l-2 border-violet/40 pl-3 text-sm"
    >
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-fg">
        <span className="font-medium">Delegated to {d.targetName}</span>
        {d.targetKind === 'agent' && <Badge tone="violet">Agent</Badge>}
        {d.native && <Badge tone="neutral">Claude Code subagent</Badge>}
        {failed && <Badge tone="danger">{d.outcome}</Badge>}
      </span>
      <span className="text-xs text-muted" data-testid="delegation-meta">
        {d.model} · {profileText(d.profile)}
        {d.durationMs !== null ? ` · ${formatMs(d.durationMs)}` : ''} · {formatCostUsd(d)}
      </span>
      {d.summary && (
        <span
          className={failed ? 'text-xs text-danger-text' : 'text-xs text-subtle'}
          data-testid="delegation-summary"
        >
          {d.summary}
        </span>
      )}
    </div>
  );
}

/** The delegations of a session, listed; nothing when there were none. */
export function DelegationSteps({ steps }: { steps: DelegationStepDto[] | undefined }) {
  if (!steps?.length) return null;
  return (
    <section
      aria-label="Delegated work"
      data-testid="delegation-steps"
      className="flex flex-col gap-2 rounded-control border border-line bg-surface px-3 py-2"
    >
      <h3 className="text-sm font-semibold text-fg">Delegated work</h3>
      {steps.map((d) => (
        <DelegationStep key={d.delegateId} d={d} />
      ))}
    </section>
  );
}
