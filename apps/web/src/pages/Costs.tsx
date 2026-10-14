import type { CostsQuery, CostsReport, SpendTotals } from '@aom/shared';
import { Download } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { costsCsvUrl, useCosts, useUpdateCostSettings } from '../api/queries/costs.ts';
import { BudgetMeter } from '../components/BudgetMeter.tsx';
import { DayBars, ShareBar } from '../components/CostCharts.tsx';
import {
  Badge,
  Button,
  Disclosure,
  EmptyState,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
  Select,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import { ValuePanel } from '../components/ValuePanel.tsx';
import { money, tokensShort as tokens } from '../lib/money.ts';
import { usePageTitle } from '../lib/usePageTitle.ts';

const iso = (d: Date) => d.toISOString().slice(0, 10);
type Preset = 'month' | 'last30' | 'lastMonth';
function presetRange(p: Preset, now = new Date()): CostsQuery {
  if (p === 'month') return {};
  if (p === 'last30') return { from: iso(new Date(now.getTime() - 29 * 86_400_000)), to: iso(now) };
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { from: iso(first), to: iso(last) };
}

const Stat = ({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  testId?: string;
}) => (
  <div className="rounded-card border border-line bg-surface p-4">
    <p className="text-sm text-muted">{label}</p>
    <p className="tnum mt-1 text-2xl font-semibold text-fg" data-testid={testId}>
      {value}
    </p>
    {sub && <p className="tnum mt-0.5 text-xs text-subtle">{sub}</p>}
  </div>
);

function Table({
  caption,
  head,
  children,
  testId,
}: {
  caption: string;
  head: string[];
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="overflow-x-auto" data-testid={testId}>
      <table className="w-full min-w-[34rem] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            {head.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={`py-2 pr-3 font-medium ${i > 0 && i < head.length - 1 ? 'text-right' : ''}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

const tokenLine = (t: SpendTotals) => `${tokens(t.inputTokens)} in · ${tokens(t.outputTokens)} out`;

function CurrencyForm({ report }: { report: CostsReport }) {
  const update = useUpdateCostSettings();
  const toast = useToast();
  const [code, setCode] = useState(report.currency);
  const [rate, setRate] = useState(String(report.settings.usdRate));
  const rateNum = Number(rate);
  const valid = /^[A-Za-z]{3}$/.test(code) && Number.isFinite(rateNum) && rateNum > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid)
      update.mutate(
        { currency: code.toUpperCase(), usdRate: rateNum },
        { onSuccess: () => toast.success('Currency saved') },
      );
  };
  return (
    <form onSubmit={submit} aria-label="Currency" className="flex flex-wrap items-end gap-3">
      <div className="w-28">
        <TextInput
          label="Currency"
          value={code}
          maxLength={3}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          data-testid="currency-code"
        />
      </div>
      <div className="w-44">
        <TextInput
          label={`${code || 'Units'} per 1 USD`}
          type="number"
          step="any"
          min={0}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          data-testid="currency-rate"
        />
      </div>
      <Button type="submit" disabled={!valid} loading={update.isPending} data-testid="currency-save">
        Save currency
      </Button>
      <ErrorBox error={update.error} />
    </form>
  );
}

/** Organization, Costs: what the agents cost, by project, agent, model and day (Owner and Admin). CSV export. */
export function Costs() {
  usePageTitle('Costs');
  const [preset, setPreset] = useState<Preset | 'custom'>('month');
  const [custom, setCustom] = useState<CostsQuery>({});
  const [projectId, setProjectId] = useState('');
  const range = preset === 'custom' ? custom : presetRange(preset);
  const query: CostsQuery = { ...range, ...(projectId ? { projectId } : {}) };
  const q = useCosts(query);

  if (q.isPending)
    return (
      <div>
        <PageHeader title="Costs" />
        <PageSkeleton label="Loading costs" panels={3} />
      </div>
    );
  if (q.isError)
    return (
      <div>
        <PageHeader title="Costs" />
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  const r = q.data;
  const cur = r.currency;
  const empty = r.totals.shifts === 0;
  const projectsForFilter = [...new Map(r.byProject.map((p) => [p.projectId, p])).values()];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Costs"
        sub={
          <span className="tnum" data-testid="costs-range">
            {r.from} to {r.to} · {r.timezone}
          </span>
        }
        actions={
          <a
            href={costsCsvUrl(query)}
            download
            data-testid="costs-export"
            className="inline-flex h-9 items-center gap-2 rounded-control border border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-sunken [@media(pointer:coarse)]:h-11"
          >
            <Download aria-hidden="true" className="size-4" />
            Export CSV
          </a>
        }
      />
      <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Range">
        {(
          [
            ['month', 'This month'],
            ['last30', 'Last 30 days'],
            ['lastMonth', 'Last month'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            aria-pressed={preset === k}
            onClick={() => setPreset(k)}
            className={`h-9 rounded-full border px-3.5 text-sm font-medium [@media(pointer:coarse)]:h-11 ${preset === k ? 'border-brand bg-brand-soft text-brand-soft-fg' : 'border-control bg-surface text-muted hover:bg-sunken'}`}
          >
            {label}
          </button>
        ))}
        <div className="w-40">
          <TextInput
            label="From"
            type="date"
            value={preset === 'custom' ? (custom.from ?? '') : r.from}
            onChange={(e) => {
              setPreset('custom');
              setCustom({ from: e.target.value, to: preset === 'custom' ? custom.to : r.to });
            }}
          />
        </div>
        <div className="w-40">
          <TextInput
            label="To"
            type="date"
            value={preset === 'custom' ? (custom.to ?? '') : r.to}
            onChange={(e) => {
              setPreset('custom');
              setCustom({ from: preset === 'custom' ? custom.from : r.from, to: e.target.value });
            }}
          />
        </div>
        <div className="w-56">
          <Select label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All projects</option>
            {projectsForFilter.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.key} {p.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <ValuePanel />

      {empty ? (
        <EmptyState
          title="No spend in this range"
          description="Costs are recorded when an agent's shift ends. Pick a wider range, or give the agents some work."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Total spend"
              value={money(r.totals.costMicros, cur)}
              sub={`${r.totals.shifts} shifts`}
              testId="costs-total"
            />
            <Stat
              label="Org overhead"
              value={money(r.overhead.costMicros, cur)}
              sub="chats and BA work outside a project"
              testId="costs-overhead"
            />
            <Stat
              label="Tokens in"
              value={tokens(r.totals.inputTokens)}
              sub={`${tokens(r.totals.cacheReadTokens)} read from cache`}
            />
            <Stat
              label="Tokens out"
              value={tokens(r.totals.outputTokens)}
              sub={`${tokens(r.totals.cacheWriteTokens)} written to cache`}
            />
          </div>
          <Panel title="By day">
            <DayBars days={r.byDay} currency={cur} />
          </Panel>
          <Panel title="By project">
            <Table
              caption="Spend by project"
              head={['Project', 'Spend', 'Tokens', 'Budget this month', 'Share']}
              testId="costs-by-project"
            >
              {r.byProject.map((p) => (
                <tr key={p.projectId} data-testid="costs-project-row">
                  <th scope="row" className="py-2 pr-3 text-left font-medium text-fg">
                    {p.interestId ? (
                      <Link to={`/interests/${p.interestId}`} className="text-brand-text hover:underline">
                        {p.name}
                      </Link>
                    ) : (
                      <Link
                        to={`/projects/${p.projectId}/settings`}
                        className="text-brand-text hover:underline"
                      >
                        {p.key} {p.name}
                      </Link>
                    )}
                    {p.interestId && <Badge className="ml-2">interest</Badge>}
                  </th>
                  <td className="tnum py-2 pr-3 text-right">{money(p.costMicros, cur)}</td>
                  <td className="tnum py-2 pr-3 text-right text-muted">{tokenLine(p)}</td>
                  <td className="py-2 pr-3">
                    {p.budget ? (
                      <BudgetMeter budget={p.budget} />
                    ) : (
                      <span className="text-subtle">No budget</span>
                    )}
                  </td>
                  <td className="py-2">
                    <ShareBar part={p.costMicros} whole={r.totals.costMicros} label={p.name} />
                  </td>
                </tr>
              ))}
              {r.overhead.costMicros > 0 && (
                <tr>
                  <th scope="row" className="py-2 pr-3 text-left font-medium text-fg">
                    Org overhead
                  </th>
                  <td className="tnum py-2 pr-3 text-right">{money(r.overhead.costMicros, cur)}</td>
                  <td className="tnum py-2 pr-3 text-right text-muted">{tokenLine(r.overhead)}</td>
                  <td className="py-2 pr-3 text-subtle">No budget</td>
                  <td className="py-2">
                    <ShareBar part={r.overhead.costMicros} whole={r.totals.costMicros} label="Org overhead" />
                  </td>
                </tr>
              )}
              {r.management && r.management.costMicros > 0 && (
                <tr data-testid="costs-management">
                  <th scope="row" className="py-2 pr-3 text-left font-medium text-fg">
                    Management (CEO)
                  </th>
                  <td className="tnum py-2 pr-3 text-right">{money(r.management.costMicros, cur)}</td>
                  <td className="tnum py-2 pr-3 text-right text-muted">{tokenLine(r.management)}</td>
                  <td className="py-2 pr-3 text-subtle">
                    <Link to="/org/ceo?tab=reporting" className="text-brand-text hover:underline">
                      Organization budget
                    </Link>
                  </td>
                  <td className="py-2">
                    <ShareBar
                      part={r.management.costMicros}
                      whole={r.totals.costMicros}
                      label="Management (CEO)"
                    />
                  </td>
                </tr>
              )}
            </Table>
          </Panel>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="By agent">
              <Table
                caption="Spend by agent"
                head={['Agent', 'Spend', 'Tokens', 'Share']}
                testId="costs-by-agent"
              >
                {r.byAgent.map((a) => (
                  <tr key={a.agentId}>
                    <th scope="row" className="py-2 pr-3 text-left font-medium text-fg">
                      {a.name} <span className="font-normal text-muted">{a.roleKey}</span>
                    </th>
                    <td className="tnum py-2 pr-3 text-right">{money(a.costMicros, cur)}</td>
                    <td className="tnum py-2 pr-3 text-right text-muted">{tokenLine(a)}</td>
                    <td className="py-2">
                      <ShareBar part={a.costMicros} whole={r.totals.costMicros} label={a.name} />
                    </td>
                  </tr>
                ))}
              </Table>
            </Panel>
            <Panel title="By model">
              <Table
                caption="Spend by model"
                head={['Model', 'Spend', 'Tokens', 'Share']}
                testId="costs-by-model"
              >
                {r.byModel.map((m) => (
                  <tr key={m.model}>
                    <th scope="row" className="py-2 pr-3 text-left font-medium text-fg">
                      {m.model}
                      {m.family.toLowerCase() !== m.model.toLowerCase() && (
                        <span className="font-normal text-muted"> {m.family}</span>
                      )}
                    </th>
                    <td className="tnum py-2 pr-3 text-right">{money(m.costMicros, cur)}</td>
                    <td className="tnum py-2 pr-3 text-right text-muted">{tokenLine(m)}</td>
                    <td className="py-2">
                      <ShareBar part={m.costMicros} whole={r.totals.costMicros} label={m.model} />
                    </td>
                  </tr>
                ))}
              </Table>
            </Panel>
          </div>
        </>
      )}
      <Panel title="Currency and prices">
        <p className="mb-3 text-sm text-muted">
          Costs are worked out from the tokens each shift used at list prices in US dollars, then shown in
          your organization's currency at the rate below. They estimate what the work costs; they are not an
          invoice.
        </p>
        <CurrencyForm report={r} />
        <div className="mt-4">
          <Disclosure summary="Prices used (US dollars per million tokens)">
            <Table
              caption="Model prices"
              head={['Model family', 'Input', 'Output', 'Cache read', 'Cache write']}
              testId="costs-prices"
            >
              {r.prices.map((p) => (
                <tr key={p.label}>
                  <th scope="row" className="py-2 pr-3 text-left font-medium text-fg">
                    {p.label}
                  </th>
                  <td className="tnum py-2 pr-3 text-right">{p.input}</td>
                  <td className="tnum py-2 pr-3 text-right">{p.output}</td>
                  <td className="tnum py-2 pr-3 text-right">{p.cacheRead}</td>
                  <td className="tnum py-2 text-right">{p.cacheWrite}</td>
                </tr>
              ))}
            </Table>
            <p className="mt-2 text-xs text-subtle">
              These are the built-in default list prices. The platform administrator will be able to change
              them.
            </p>
          </Disclosure>
        </div>
      </Panel>
    </div>
  );
}
