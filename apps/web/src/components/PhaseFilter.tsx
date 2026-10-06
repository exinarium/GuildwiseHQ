import type { PhaseSummaryDto } from '@aom/shared';

/** The board's phase filter: all cards, the cards of one phase, or the cards without a phase. */
export function PhaseFilter({
  phases,
  value,
  onChange,
}: {
  phases: readonly PhaseSummaryDto[];
  value: string;
  onChange: (v: string) => void;
}) {
  const shown = phases.filter((p) => !['discarded', 'cancelled'].includes(p.status));
  if (shown.length === 0) return null;
  return (
    <>
      <label className="sr-only" htmlFor="phase-filter">
        Phase
      </label>
      <select
        id="phase-filter"
        data-testid="phase-filter"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-control border border-control bg-surface px-3 text-sm text-fg [@media(pointer:coarse)]:h-11"
      >
        <option value="">All phases</option>
        <option value="none">No phase</option>
        {shown.map((p) => (
          <option key={p.id} value={p.id}>
            {p.ref} {p.name}
          </option>
        ))}
      </select>
    </>
  );
}
