import { type GraphContextReport, GraphContextReportSchema } from '@aom/shared';
import { useQuery } from '@tanstack/react-query';
import { get } from '../api/client.ts';
import { formatDateTime } from '../lib/time.ts';
import { Badge, ErrorBox, Panel } from './ui.tsx';

export const useGraphContext = () =>
  useQuery({
    queryKey: ['value-graph'],
    queryFn: () => get('/value/graph', GraphContextReportSchema),
    retry: false,
  });

const num = (n: number | null, digits = 0) =>
  n === null ? '-' : n.toLocaleString(undefined, { maximumFractionDigits: digits });
const kb = (n: number | null) => (n === null ? '-' : `${(n / 1024).toFixed(1)} KB`);

const WHY: Record<GraphContextReport['claim']['reason'], string> = {
  ok: '',
  not_enough_cards: 'Not enough finished cards in both groups yet to say anything (at least 10 each).',
  interval_includes_one: 'The difference is within what chance could explain, so no saving is claimed (yet).',
  no_saving: 'The groups show no saving in billed input tokens.',
  guard_worse: 'The cards that used the code map did worse on a quality measure, so no saving is claimed.',
};

const GUARD_LABEL: Record<string, string> = {
  reworkRounds: 'rework rounds per card',
  changesRequested: 'changes requested per card',
  testerFailures: 'tester failures per card',
  daysToDone: 'days to done',
  costPerCardUsd: 'cost per accepted card',
};

/**
 * What the code map saved, measured: finished cards that ran with it against the one card in five that ran without it for
 * the first four weeks. Shown for Owners and Admins; the percentage appears only when the rule of the design holds.
 */
export function GraphContextPanel() {
  const q = useGraphContext();
  if (q.isError) return null;
  const r = q.data;
  if (!r?.on || !r.off || (r.on.cards === 0 && r.off.cards === 0 && !r.evaluating)) return null;
  const arm = (label: string, a: GraphContextReport['on'], d: GraphContextReport['discovery']['on']) => (
    <tr key={label} className="border-t border-line">
      <td className="py-1 pr-3 font-medium text-fg">{label}</td>
      <td className="py-1 pr-3">{a.cards}</td>
      <td className="py-1 pr-3">{num(a.median)}</td>
      <td className="py-1 pr-3">
        {num(a.p25)} to {num(a.p75)}
      </td>
      <td className="py-1 pr-3">{kb(d.medianBytes)}</td>
      <td className="py-1">{num(d.medianCalls)}</td>
    </tr>
  );
  return (
    <Panel>
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold text-fg">
        Code map: what it saved
        {r.evaluating && <Badge tone="blue">measuring</Badge>}
      </h2>
      <p className="mb-3 text-sm text-muted">
        Billed input tokens per finished card, for cards whose agents had the code map and for the one card in
        five that ran without it
        {r.windowEndsAt ? ` (until ${formatDateTime(r.windowEndsAt)})` : ''}. Only numbers are counted;
        nothing about your code is kept here.
      </p>
      {r.claim.allowed && r.interval ? (
        <p className="mb-3 text-sm text-fg" data-testid="graph-claim">
          Cards with the code map used {r.claim.savingPercent}% fewer billed input tokens (the likely range is{' '}
          {Math.max(0, Math.round((1 - r.interval.hi) * 100))}% to {Math.round((1 - r.interval.lo) * 100)}%),
          and none of the quality measures got worse.
        </p>
      ) : (
        <p className="mb-3 text-sm text-muted" data-testid="graph-claim-none">
          {WHY[r.claim.reason]}
          {r.claim.worseGuards.length > 0 &&
            ` Worse: ${r.claim.worseGuards.map((g) => GUARD_LABEL[g]).join(', ')}.`}
        </p>
      )}
      <table className="w-full text-left text-sm" data-testid="graph-arms">
        <thead className="text-xs text-subtle">
          <tr>
            <th className="pr-3 font-normal">Group</th>
            <th className="pr-3 font-normal">Cards</th>
            <th className="pr-3 font-normal">Median tokens</th>
            <th className="pr-3 font-normal">Middle half</th>
            <th className="pr-3 font-normal">Searching before the first edit</th>
            <th className="font-normal">Search calls</th>
          </tr>
        </thead>
        <tbody>
          {arm('With the map', r.on, r.discovery.on)}
          {arm('Without it', r.off, r.discovery.off)}
        </tbody>
      </table>
      <ErrorBox error={q.error} />
    </Panel>
  );
}
