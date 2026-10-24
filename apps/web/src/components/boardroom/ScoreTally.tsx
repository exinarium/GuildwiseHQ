import type { BoardOptionScore } from '@aom/shared';

/** Option scoring: one row per option, one column per scoring seat, then total and average. The top option is highlighted. */
export function ScoreTally({ scores }: { scores: readonly BoardOptionScore[] }) {
  if (!scores.length) return null;
  const names = [...new Set(scores.flatMap((o) => o.scores.map((s) => s.name)))];
  const top = scores[0]?.option;
  return (
    <div className="overflow-x-auto" data-testid="score-tally">
      <h3 className="mb-1 text-sm font-semibold text-fg">Option scores</h3>
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-subtle">
            <th className="py-1 pr-3 font-medium">Option</th>
            {names.map((n) => (
              <th key={n} className="px-2 py-1 font-medium">
                {n}
              </th>
            ))}
            <th className="px-2 py-1 font-medium">Total</th>
            <th className="px-2 py-1 font-medium">Average</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((o) => (
            <tr
              key={o.option}
              data-testid="score-row"
              data-top={o.option === top ? 'true' : undefined}
              className={o.option === top ? 'bg-success-soft font-medium text-fg' : 'text-fg'}
            >
              <td className="py-1 pr-3 [overflow-wrap:anywhere]">{o.option}</td>
              {names.map((n) => (
                <td key={n} className="tnum px-2 py-1">
                  {o.scores.find((s) => s.name === n)?.score ?? '-'}
                </td>
              ))}
              <td className="tnum px-2 py-1">{o.total}</td>
              <td className="tnum px-2 py-1">{o.average ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
