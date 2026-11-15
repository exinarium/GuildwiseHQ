import type { ReplayDto, ReplayResult } from '@aom/shared';

const mins = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const prec = (p: number | null) => (p === null ? '–' : p.toFixed(2));

/** Precision per reviewer and the owner's recorded marking effort: the baseline for the targets. */
export function ReplayResults({ replay }: { replay: ReplayDto }) {
  const r: ReplayResult | null = replay.result;
  if (!r) return null;
  const e = r.effort;
  return (
    <section aria-label="Replay result" className="space-y-3" data-testid="replay-result">
      <ul className="space-y-2">
        {r.reviewers.map((x) => (
          <li
            key={x.reviewer}
            className="rounded-control border border-border p-3"
            data-testid={`replay-reviewer-${x.reviewer}`}
          >
            <p className="font-medium">
              {x.label} · {x.model}
            </p>
            <p>
              Precision <strong data-testid={`replay-precision-${x.reviewer}`}>{prec(x.precision)}</strong>
            </p>
            <p className="text-muted">
              {x.prsReviewed} of {r.prCount} pull requests reviewed · {x.wouldPost} would be posted ·{' '}
              {x.useful} useful · {x.noise} noise · {x.heldBack} held back · marking time {mins(x.effortMs)}
            </p>
          </li>
        ))}
      </ul>
      <div className="rounded-control border border-border p-3" data-testid="replay-effort">
        <p className="font-medium">Your review effort</p>
        <p>
          Marking time {mins(e.activeMs)} in total · {mins(e.perPrMs)} per pull request
          {e.perFindingMs !== null && ` · ${mins(e.perFindingMs)} per finding`} · {e.findingsMarked} findings
          marked
        </p>
        <p>
          ≈ {e.hoursPerWeekEstimate.toFixed(2)} h per week (estimate at {e.prsPerWeek} merged pull requests
          per week)
        </p>
      </div>
      <p className="text-muted">
        Precision = useful ÷ findings that would have been posted (after the findings cap). Marking time
        counts at most {Math.round(e.idleCapMs / 60_000)} minutes per finding.
      </p>
    </section>
  );
}
