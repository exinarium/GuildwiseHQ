import {
  type AgentStats as AgentStatsDto,
  countsAgainstBuilder,
  REWORK_REASON_LABEL,
  type StatValue,
  type WorkQuality,
} from '@aom/shared';
import { type Direction, describeStat, num, pct, tokens, versusTeam } from '../../lib/hr.ts';
import { CompareBar, Sparkline } from './Charts.tsx';

interface Row {
  key: string;
  label: string;
  meaning: string;
  stat: StatValue;
  fmt: (n: number | null) => string;
  /** The track maximum for the bar (rates are 0..1); null: no bar. */
  max: number | null;
  lowerIsBetter: boolean;
}

const WORDS: Record<Direction, string> = {
  better: 'better than the team average',
  worse: 'worse than the team average',
  same: 'level with the team average',
  unknown: 'no team comparison yet',
};

/** The six stats of the HR card over the rolling window, each against the average of the agents in the role. */
export function AgentStats({ stats, roleName }: { stats: AgentStatsDto; roleName: string }) {
  const rows: Row[] = [
    {
      key: 'cards-done',
      label: 'Cards done',
      meaning: 'Cards moved out of its stage',
      stat: stats.cardsDone,
      fmt: num,
      max: null,
      lowerIsBetter: false,
    },
    {
      key: 'blocked-rate',
      label: 'Blocked rate',
      meaning: 'Share of its cards that raised a question',
      stat: stats.blockedRate,
      fmt: pct,
      max: 1,
      lowerIsBetter: true,
    },
    {
      key: 'rework-rate',
      label: 'Rework rate',
      meaning: 'Share of its cards sent back by review',
      stat: stats.reworkRate,
      fmt: pct,
      max: 1,
      lowerIsBetter: true,
    },
    {
      key: 'bugs-escaped',
      label: 'Bugs escaped',
      meaning: 'Share of its cards that later failed test',
      stat: stats.bugsEscaped,
      fmt: pct,
      max: 1,
      lowerIsBetter: true,
    },
    {
      key: 'utilisation',
      label: 'Utilisation',
      meaning: 'Share of time on shift versus idle',
      stat: stats.utilisation,
      fmt: pct,
      max: 1,
      lowerIsBetter: false,
    },
    {
      key: 'tokens-per-card',
      label: 'Tokens per card',
      meaning: 'Average tokens used per completed card',
      stat: stats.tokensPerCard,
      fmt: tokens,
      max: null,
      lowerIsBetter: true,
    },
  ];
  return (
    <section
      data-testid="agent-stats"
      aria-label={`Stats over ${stats.windowDays} days against the ${roleName} average`}
    >
      <div className="mb-1 flex items-center justify-between text-xs text-subtle">
        <span>
          {stats.windowDays}-day window, against the {roleName} average
        </span>
        <Sparkline
          values={stats.doneByDay}
          label={`Cards done per day, last ${stats.doneByDay.length} days`}
        />
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
        {rows.map((r) => {
          const dir = versusTeam(r.stat, r.lowerIsBetter);
          return (
            <div key={r.key} data-testid={`stat-${r.key}`} title={r.meaning}>
              <dt className="text-xs text-subtle">{r.label}</dt>
              <dd className="m-0">
                <span className="text-sm font-semibold tabular-nums" data-testid="stat-value">
                  {r.fmt(r.stat.value)}
                </span>
                <span className="ml-1 text-xs text-subtle" data-testid="stat-team">
                  team {r.fmt(r.stat.team)}
                </span>
                {r.max !== null && (
                  <CompareBar
                    value={r.stat.value}
                    team={r.stat.team}
                    max={r.max}
                    label={`${r.label}: ${describeStat(r.stat, r.fmt)}, ${WORDS[dir]}`}
                  />
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/** Work quality of a builder: a builder can be fast and rarely blocked and still produce poor work. */
export function WorkQualityPanel({ quality }: { quality: WorkQuality }) {
  const q = quality;
  const scored = q.reviewCount > 0;
  return (
    <div data-testid="work-quality" className="rounded-control bg-sunken p-2 text-sm">
      <p className="mb-1 text-xs font-semibold tracking-wide text-subtle uppercase">Work quality</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <div
          data-testid="quality-score"
          title="Reviewer score 1 to 5 against the spec and conventions, rolling average"
        >
          <dt className="text-xs text-subtle">Reviewer score</dt>
          <dd className="m-0 font-semibold tabular-nums">
            {scored ? `${q.reviewScoreAvg?.toFixed(1)} of 5` : '–'}
            {scored && <span className="ml-1 text-xs font-normal text-subtle">({q.reviewCount})</span>}
          </dd>
        </div>
        <div data-testid="quality-rounds" title="One bounce is normal, three on the same card is a pattern">
          <dt className="text-xs text-subtle">Rework rounds per card</dt>
          <dd className="m-0 font-semibold tabular-nums">
            {num(q.reworkRoundsPerCard.avg)}
            <span className="ml-1 text-xs font-normal text-subtle">
              max {q.reworkRoundsPerCard.max}
              {q.reworkRoundsPerCard.cardsWithThreeOrMore > 0 &&
                `, ${q.reworkRoundsPerCard.cardsWithThreeOrMore} with 3+`}
            </span>
          </dd>
        </div>
        <div data-testid="quality-bugs" title="Test failures and later regressions traced back to its cards">
          <dt className="text-xs text-subtle">Bugs escaped</dt>
          <dd className="m-0 font-semibold tabular-nums">{q.bugsEscaped}</dd>
        </div>
        <div data-testid="quality-criteria" title="Acceptance criteria the reviewer found unmet at handoff">
          <dt className="text-xs text-subtle">Criteria missed</dt>
          <dd className="m-0 font-semibold tabular-nums">{q.criteriaMissed}</dd>
        </div>
        <div
          data-testid="quality-coverage"
          className="col-span-2"
          title="Whether the builder wrote or updated tests with the code"
        >
          <dt className="text-xs text-subtle">Test coverage of its changes</dt>
          <dd className="m-0 font-semibold tabular-nums">
            {q.testCoverage.cardsMeasured > 0
              ? `${pct(q.testCoverage.rate)} (${q.testCoverage.cardsWithTests} of ${q.testCoverage.cardsMeasured} cards)`
              : '–'}
          </dd>
        </div>
      </dl>
      <div className="mt-2" data-testid="quality-reasons">
        <p className="text-xs text-subtle">Rework by reason</p>
        {q.reworkByReason.length === 0 ? (
          <p className="text-xs text-subtle">No review bounces.</p>
        ) : (
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {q.reworkByReason.map((r) => (
              <li
                key={r.reason}
                data-testid={`reason-${r.reason}`}
                className="flex justify-between gap-2 text-xs"
              >
                <span>
                  {REWORK_REASON_LABEL[r.reason]}
                  {!countsAgainstBuilder(r.reason) && (
                    <span className="ml-1 text-subtle">(not counted against the builder)</span>
                  )}
                </span>
                <span className="tabular-nums">{r.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
