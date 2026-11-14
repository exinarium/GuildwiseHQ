import type { ProjectDto, ReplayResult } from '@aom/shared';
import { useState } from 'react';
import { useSetReviewTargets } from '../../api/queries/pr-replays.ts';
import { ErrorBox } from '../ui.tsx';

const num = (v: string): number => Number(v.trim().replace(',', '.'));

/**
 * The owner types the targets. The fields start empty: the replay's figures are shown as reference, never pre-filled.
 * Text inputs with a decimal keypad, so the soft keyboard opens on touch devices.
 */
export function ReviewTargetsForm({
  projectId,
  canManage,
  result,
  saved,
}: {
  projectId: string;
  canManage: boolean;
  result: ReplayResult | null;
  saved: ProjectDto['reviewTargets'];
}) {
  const set = useSetReviewTargets(projectId);
  const [precision, setPrecision] = useState('');
  const [effort, setEffort] = useState('');
  const [done, setDone] = useState(false);
  const hasSaved = saved?.precisionTarget != null && saved.effortTargetHoursPerWeek != null;
  const reference = result?.reviewers
    .map((r) => `${r.label} ${r.precision === null ? '–' : r.precision.toFixed(2)}`)
    .join(', ');
  const p = num(precision);
  const h = num(effort);
  const valid = precision.trim() !== '' && effort.trim() !== '' && p >= 0 && p <= 100 && h >= 0 && h <= 168;
  if (!canManage)
    return hasSaved ? (
      <p data-testid="targets-saved">
        Targets: precision {Math.round((saved?.precisionTarget ?? 0) * 100)} %, review effort{' '}
        {saved?.effortTargetHoursPerWeek} h per week.
      </p>
    ) : null;
  return (
    <form
      className="space-y-3"
      aria-label="Targets"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!valid) return;
        set.mutate(
          { precisionTarget: Math.round(p) / 100, effortTargetHoursPerWeek: Math.round(h * 10) / 10 },
          { onSuccess: () => setDone(true) },
        );
      }}
    >
      {hasSaved && (
        <p data-testid="targets-saved">
          Saved: precision {Math.round((saved?.precisionTarget ?? 0) * 100)} %, review effort{' '}
          {saved?.effortTargetHoursPerWeek} h per week.
        </p>
      )}
      <div>
        <label htmlFor="precision-target" className="block font-medium">
          Reviewer precision target (%)
        </label>
        <input
          id="precision-target"
          type="text"
          inputMode="decimal"
          value={precision}
          onChange={(e) => setPrecision(e.target.value)}
          aria-describedby="precision-help"
          className="min-h-11 w-full rounded-control border border-border px-3"
        />
        <p id="precision-help" className="text-muted">
          0 to 100. Replay: {reference}
        </p>
      </div>
      <div>
        <label htmlFor="effort-target" className="block font-medium">
          Baseline review effort target (hours per week)
        </label>
        <input
          id="effort-target"
          type="text"
          inputMode="decimal"
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
          aria-describedby="effort-help"
          className="min-h-11 w-full rounded-control border border-border px-3"
        />
        <p id="effort-help" className="text-muted">
          0 to 168. Replay estimate: {result?.effort.hoursPerWeekEstimate.toFixed(1)} h/week
        </p>
      </div>
      <button
        type="submit"
        disabled={!valid || set.isPending}
        className="inline-flex min-h-11 items-center rounded-control border border-border px-4 font-medium disabled:opacity-60"
      >
        Save
      </button>
      {done && <p role="status">Targets saved. The rollout is complete.</p>}
      {set.isError && <ErrorBox error={set.error} />}
    </form>
  );
}
