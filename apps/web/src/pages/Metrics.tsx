import { useState } from 'react';
import { useMetrics } from '../api/queries/hr.ts';
import { useProjects } from '../api/queries/projects.ts';
import { BarChart, HBars, Stat } from '../components/hr/Charts.tsx';
import { ErrorBox, PageHeader, Panel, Select, Spinner } from '../components/ui.tsx';
import { duration, pct } from '../lib/hr.ts';

const RANGES = [7, 14, 30, 90] as const;

/** The manager dashboard's numbers: throughput, time blocked on the manager, bounce rate, bugs, durations, queues. */
export function Metrics() {
  const projects = useProjects();
  const [projectId, setProjectId] = useState('');
  const [days, setDays] = useState<number>(30);
  const m = useMetrics(projectId || undefined, days);
  const d = m.data;
  const total = (xs: Array<{ count: number }>) => xs.reduce((s, x) => s + x.count, 0);
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3">
      <PageHeader
        title="Metrics"
        sub="What the team delivered, where it waited on you, and where quality slipped."
      />
      <div className="flex flex-wrap gap-3">
        {(projects.data?.length ?? 0) > 1 && (
          <div className="w-56">
            <Select label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">All projects</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.key} {p.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="w-40">
          <Select label="Range" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((r) => (
              <option key={r} value={r}>
                Last {r} days
              </option>
            ))}
          </Select>
        </div>
      </div>
      {m.isPending && <Spinner />}
      <ErrorBox error={m.error} />
      {d && (
        <div className="grid gap-3 md:grid-cols-2" data-testid="metrics">
          <Panel>
            <h2 className="mb-3 text-lg font-semibold text-fg">Throughput</h2>
            <div className="mb-2 flex gap-6">
              <Stat label="Cards finalized" value={total(d.throughput)} testId="metric-throughput-total" />
              <Stat
                label="Per day"
                value={(total(d.throughput) / Math.max(1, d.throughput.length)).toFixed(1)}
              />
            </div>
            <BarChart
              caption={`Cards finalized per day, ${d.throughput.length} days`}
              data={d.throughput.map((x) => ({ label: x.day, value: x.count }))}
            />
          </Panel>

          <Panel>
            <h2 className="mb-3 text-lg font-semibold text-fg">Time blocked on you</h2>
            <div className="flex gap-6" data-testid="metric-blocked">
              <Stat label="Total" value={duration(d.timeBlockedOnManager.totalMs)} />
              <Stat label="Cards held up" value={d.timeBlockedOnManager.cards} />
              <Stat label="Average per card" value={duration(d.timeBlockedOnManager.avgMsPerCard)} />
            </div>
          </Panel>

          <Panel>
            <h2 className="mb-3 text-lg font-semibold text-fg">Bounce rate per builder</h2>
            {d.bounceRate.length === 0 ? (
              <p className="text-sm text-subtle">No builder submitted a card in this range.</p>
            ) : (
              <table className="w-full text-sm" data-testid="metric-bounce">
                <thead className="text-left text-xs text-subtle">
                  <tr>
                    <th scope="col">Builder</th>
                    <th scope="col" className="text-right">
                      Submitted
                    </th>
                    <th scope="col" className="text-right">
                      Review bounces
                    </th>
                    <th scope="col" className="text-right">
                      Test failures
                    </th>
                    <th scope="col" className="text-right">
                      Rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.bounceRate.map((b) => (
                    <tr key={b.agentId} data-testid={`bounce-${b.name}`}>
                      <th scope="row" className="text-left font-medium">
                        {b.name}
                      </th>
                      <td className="text-right tabular-nums">{b.submitted}</td>
                      <td className="text-right tabular-nums">{b.reviewBounces}</td>
                      <td className="text-right tabular-nums">{b.testFailures}</td>
                      <td className="text-right tabular-nums">{pct(b.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel>
            <h2 className="mb-3 text-lg font-semibold text-fg">Bugs escaped past test</h2>
            <Stat label="Failed test runs" value={d.bugsEscaped.total} testId="metric-bugs-total" />
            <BarChart
              caption={`Failed test runs per day, ${d.bugsEscaped.byDay.length} days`}
              data={d.bugsEscaped.byDay.map((x) => ({ label: x.day, value: x.count }))}
              height={56}
            />
          </Panel>

          <Panel>
            <h2 className="mb-3 text-lg font-semibold text-fg">Duration</h2>
            <div className="mb-2 flex gap-6" data-testid="metric-duration">
              <Stat label="Cards finished" value={d.duration.cards} />
              <Stat label="Average per card" value={duration(d.duration.avgMsPerCard)} />
              <Stat label="Median per card" value={duration(d.duration.medianMsPerCard)} />
            </div>
            {d.duration.perAgent.length > 0 && (
              <HBars
                caption="Shift time per agent"
                data={d.duration.perAgent.map((a) => ({ label: a.name, value: a.totalMs }))}
                format={duration}
              />
            )}
          </Panel>

          <Panel>
            <h2 className="mb-3 text-lg font-semibold text-fg">Queue depth per column</h2>
            {d.queueDepth.length === 0 ? (
              <p className="text-sm text-subtle">No open cards.</p>
            ) : (
              <div data-testid="metric-queue">
                <HBars
                  caption="Cards per board column"
                  data={d.queueDepth.map((c) => ({ label: c.column, value: c.count }))}
                />
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
