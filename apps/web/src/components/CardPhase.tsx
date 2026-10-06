import type { CardDetailResponse } from '@aom/shared';
import { Link } from 'react-router';
import { useAssignCardPhase, usePhases } from '../api/queries/phases.ts';
import { phasePath } from '../lib/phases.ts';
import { Badge, ErrorBox, Select } from './ui.tsx';

/**
 * The phase of a card: shown with a "proposed" badge while the BA's suggestion is not confirmed, and changeable while
 * the card is open and both the old and the new phase still take changes.
 */
export function CardPhase({
  cardId,
  projectId,
  phase,
  canSet,
  status,
}: {
  cardId: string;
  projectId: string;
  phase: CardDetailResponse['phase'];
  canSet: boolean;
  status: string;
}) {
  const phases = usePhases(projectId);
  const assign = useAssignCardPhase();
  const closed = status === 'done' || status === 'cancelled';
  const locked = !!phase && phase.status !== 'open' && phase.status !== 'proposed';
  const reason = closed
    ? 'The card is closed: it can no longer change phase'
    : locked
      ? `${phase?.ref} is ${phase?.status.replaceAll('_', ' ')}: it no longer takes changes`
      : !canSet
        ? 'A suite or bug-fix card rides on the card it belongs to'
        : '';
  const choices = (phases.data ?? []).filter((p) => p.status === 'open' || p.status === 'proposed');
  return (
    <div data-testid="card-phase" className="flex flex-col gap-1">
      <div className={phase ? 'flex flex-wrap items-center gap-1.5 text-sm' : 'hidden'}>
        {phase ? (
          <>
            <Link to={phasePath(phase.ref)} className="font-mono underline" data-testid="card-phase-link">
              {phase.ref}
            </Link>
            <span>{phase.name}</span>
            {phase.assignment === 'proposed' && (
              <span data-testid="card-phase-proposed">
                <Badge tone="amber" title="The BA proposed it; the manager confirms on the desk">
                  proposed
                </Badge>
              </span>
            )}
          </>
        ) : null}
      </div>
      <Select
        label="Phase"
        value={phase?.id ?? ''}
        disabled={!canSet || closed || locked || assign.isPending}
        title={reason || undefined}
        data-testid="card-phase-select"
        onChange={(e) => assign.mutate({ cardId, phaseId: e.target.value || null })}
      >
        <option value="">No phase</option>
        {phase && !choices.some((p) => p.id === phase.id) && <option value={phase.id}>{phase.ref}</option>}
        {choices.map((p) => (
          <option key={p.id} value={p.id}>
            {p.ref} {p.name}
          </option>
        ))}
      </Select>
      {reason && (
        <p className="text-xs text-subtle" data-testid="card-phase-reason">
          {reason}
        </p>
      )}
      <ErrorBox error={assign.error} />
    </div>
  );
}
