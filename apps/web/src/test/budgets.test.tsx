import type { BudgetDto, CostsReport, DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetBanner } from '../components/BudgetBanner.tsx';
import { BudgetMeter } from '../components/BudgetMeter.tsx';
import { BudgetPanel } from '../components/BudgetPanel.tsx';
import { buildNav } from '../components/shell/nav-config.ts';
import { money, percentText } from '../lib/money.ts';
import { Costs } from '../pages/Costs.tsx';
import { DeskItem } from '../pages/Desk.tsx';

afterEach(() => vi.unstubAllGlobals());

const U = (n: number) => `0192f3a0-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const budget = (over: Partial<BudgetDto> = {}): BudgetDto => ({
  state: 'ok',
  month: '2026-10',
  monthlyMicros: 10_000_000,
  spentMicros: 3_000_000,
  percent: 30,
  resetsAt: '2026-11-01T00:00:00.000Z',
  currency: 'USD',
  canEdit: true,
  ...over,
});

interface Call {
  method: string;
  url: string;
  body: unknown;
}
function stub(routes: Record<string, (c: Call) => unknown> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = {
        method: init?.method ?? 'GET',
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      for (const [k, fn] of Object.entries(routes)) if (call.url.includes(k)) return json(fn(call));
      return json({ ok: true });
    }),
  );
  return calls;
}
const wrap = (node: React.ReactNode, path = '/') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={node} />
          <Route path="*" element={<p data-testid="elsewhere">elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('money', () => {
  it('formats micro-units in the organization currency', () => {
    expect(money(12_340_000, 'USD')).toBe('$12.34');
    expect(money(4_050, 'USD')).toBe('$0.004');
    expect(money(null)).toBe('–');
    expect(percentText(82.9)).toBe('82%');
  });
});

describe('budget meter', () => {
  it('is a progress bar with the spend, the budget and a text value', () => {
    wrap(<BudgetMeter budget={budget({ spentMicros: 8_000_000, percent: 80, state: 'warning' })} />);
    const bar = screen.getByRole('progressbar', { name: 'Spent this month' });
    expect(bar).toHaveAttribute('aria-valuenow', '80');
    expect(bar).toHaveAttribute('aria-valuetext', '80% of the monthly budget');
    expect(screen.getByTestId('budget-spent')).toHaveTextContent('$8.00 of $10.00');
  });
  it('shows only the state to someone who may not see amounts, and nothing without a budget', () => {
    const { unmount } = wrap(
      <BudgetMeter
        budget={budget({ state: 'paused', monthlyMicros: null, spentMicros: null, percent: null })}
      />,
    );
    expect(screen.getByTestId('budget-state-only')).toHaveTextContent('Paused');
    unmount();
    const { container } = wrap(
      <BudgetMeter
        budget={budget({ state: 'none', monthlyMicros: null, spentMicros: null, percent: null })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('budget banner', () => {
  it('says the project is paused and offers both ways out to Owner and Admin', async () => {
    const user = userEvent.setup();
    const calls = stub();
    wrap(
      <BudgetBanner
        budget={budget({ state: 'paused', spentMicros: 12_000_000, percent: 120 })}
        projectId={U(5)}
        name="TOY"
        settingsTo="/projects/x/settings#budget"
      />,
    );
    const banner = screen.getByTestId('budget-banner');
    expect(banner).toHaveTextContent('TOY is paused: its monthly budget is used up');
    expect(banner).toHaveTextContent('$12.00 of $10.00');
    expect(banner).toHaveTextContent('resets on 1 Nov');
    expect(within(banner).getByTestId('budget-raise')).toHaveAttribute('href', '/projects/x/settings#budget');
    await user.click(within(banner).getByTestId('budget-override'));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.endsWith(`/api/projects/${U(5)}/budget/override`)),
      ).toBe(true),
    );
  });
  it('has no buttons for a member, a notice at 80% and a note when overridden; nothing when fine', () => {
    const { unmount } = wrap(
      <BudgetBanner budget={budget({ state: 'paused', canEdit: false })} projectId={U(5)} settingsTo="/x" />,
    );
    expect(within(screen.getByTestId('budget-banner')).queryByTestId('budget-raise')).toBeNull();
    expect(within(screen.getByTestId('budget-banner')).queryByTestId('budget-override')).toBeNull();
    unmount();
    const w = wrap(
      <BudgetBanner
        budget={budget({ state: 'warning', percent: 85, spentMicros: 8_500_000 })}
        projectId={U(5)}
        settingsTo="/x"
      />,
    );
    expect(screen.getByTestId('budget-banner')).toHaveTextContent(
      'At 100% dispatching on this project pauses',
    );
    w.unmount();
    const o = wrap(
      <BudgetBanner budget={budget({ state: 'overridden' })} projectId={U(5)} settingsTo="/x" />,
    );
    expect(screen.getByTestId('budget-banner')).toHaveTextContent('overridden for this month');
    o.unmount();
    const ok = wrap(<BudgetBanner budget={budget()} projectId={U(5)} settingsTo="/x" />);
    expect(ok.container).toBeEmptyDOMElement();
  });
});

describe('budget panel', () => {
  it('saves a new monthly amount, removes it, and overrides a pause', async () => {
    const user = userEvent.setup();
    const calls = stub();
    wrap(
      <BudgetPanel
        kind="projects"
        id={U(5)}
        budget={budget({ state: 'paused', spentMicros: 11_000_000, percent: 110 })}
      />,
    );
    expect(screen.getByTestId('budget-state')).toHaveTextContent('Paused');
    expect(screen.getByTestId('budget-save')).toBeDisabled();
    const input = screen.getByTestId('budget-input') as HTMLInputElement;
    expect(input.value).toBe('10');
    await user.clear(input);
    await user.type(input, '25.5');
    await user.click(screen.getByTestId('budget-save'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ monthly: 25.5 }));
    expect(calls.find((c) => c.method === 'PUT')?.url).toContain(`/api/projects/${U(5)}/budget`);
    await user.click(screen.getByTestId('budget-clear'));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ monthly: null }),
    );
    await user.click(screen.getByTestId('budget-override-settings'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/budget/override'))).toBe(true));
  });
  it('refuses a zero or negative amount and is read-only for a member', async () => {
    const user = userEvent.setup();
    stub();
    const { unmount } = wrap(
      <BudgetPanel
        kind="interests"
        id={U(5)}
        budget={budget({ monthlyMicros: null, spentMicros: 0, percent: null, state: 'none' })}
        what="interest"
      />,
    );
    await user.type(screen.getByTestId('budget-input'), '-3');
    expect(screen.getByText('Enter an amount above zero')).toBeInTheDocument();
    expect(screen.getByTestId('budget-save')).toBeDisabled();
    unmount();
    wrap(<BudgetPanel kind="projects" id={U(5)} budget={budget({ canEdit: false })} />);
    expect(screen.queryByTestId('budget-input')).toBeNull();
    expect(
      screen.getByText(/Only the organization's Owner and Admins can change the budget/),
    ).toBeInTheDocument();
  });
});

const report = (over: Partial<CostsReport> = {}): CostsReport => {
  const t = (cost: number, shifts = 2) => ({
    costMicros: cost,
    shifts,
    inputTokens: 2000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  return {
    currency: 'USD',
    timezone: 'Africa/Johannesburg',
    from: '2026-10-01',
    to: '2026-10-07',
    totals: t(12_000_000, 8),
    overhead: t(2_000_000, 1),
    byProject: [
      {
        ...t(8_000_000),
        projectId: U(5),
        key: 'TOY',
        name: 'Toy',
        interestId: null,
        budget: budget({ spentMicros: 8_000_000, percent: 80, state: 'warning' }),
      },
      { ...t(2_000_000), projectId: U(6), key: 'NEWS', name: 'AI news', interestId: U(7), budget: null },
    ],
    byAgent: [{ ...t(9_000_000), agentId: U(20), name: 'Ben', roleKey: 'builder' }],
    byModel: [{ ...t(12_000_000), model: 'claude-sonnet-4-5', family: 'Sonnet' }],
    byDay: [
      { ...t(5_000_000), date: '2026-10-05' },
      { ...t(7_000_000), date: '2026-10-06' },
    ],
    prices: [{ match: 'sonnet', label: 'Sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
    settings: { currency: 'USD', usdRate: 1, timezone: 'Africa/Johannesburg', canEdit: true },
    ...over,
  };
};

describe('the Costs page: Management (CEO)', () => {
  it('shows the CEO spend as its own row, and none without a CEO', async () => {
    const t = (cost: number) => ({
      costMicros: cost,
      shifts: 3,
      inputTokens: 1500,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    stub({ '/api/costs': () => report({ management: t(3_000_000) }) });
    wrap(<Costs />);
    const row = await screen.findByTestId('costs-management');
    expect(row).toHaveTextContent('Management (CEO)');
    expect(row).toHaveTextContent('$3.00');
  });
  it('has no Management row without a CEO', async () => {
    stub({ '/api/costs': () => report() });
    wrap(<Costs />);
    await screen.findByTestId('costs-total');
    expect(screen.queryByTestId('costs-management')).toBeNull();
  });
});

describe('the Costs page', () => {
  it('breaks spend down by project, agent, model and day, with budgets and a CSV link', async () => {
    const calls = stub({ '/api/costs': () => report() });
    wrap(<Costs />);
    expect(await screen.findByTestId('costs-total')).toHaveTextContent('$12.00');
    expect(screen.getByTestId('costs-overhead')).toHaveTextContent('$2.00');
    const rows = screen.getAllByTestId('costs-project-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('TOY Toy');
    expect(within(rows[0] as HTMLElement).getByTestId('budget-meter')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('AI news');
    expect(rows[1]).toHaveTextContent('interest');
    expect(rows[1]).toHaveTextContent('No budget');
    expect(screen.getByTestId('costs-by-agent')).toHaveTextContent('Ben');
    expect(screen.getByTestId('costs-by-model')).toHaveTextContent('Sonnet');
    expect(
      screen.getByRole('img', {
        name: /Spend per day, 2 days with spend, \$12\.00 in total, highest on 2026-10-06 at \$7\.00/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('costs-range')).toHaveTextContent(
      '2026-10-01 to 2026-10-07 · Africa/Johannesburg',
    );
    expect(screen.getByTestId('costs-export')).toHaveAttribute('href', '/api/costs/export.csv');
    expect(calls.some((c) => c.url.endsWith('/api/costs'))).toBe(true);
  });

  it('changes the range and keeps it in the export link; saves the currency', async () => {
    const user = userEvent.setup();
    const calls = stub({ '/api/costs': () => report(), '/api/costs/settings': () => ({}) });
    wrap(<Costs />);
    await screen.findByTestId('costs-total');
    await user.click(screen.getByRole('button', { name: 'Last 30 days' }));
    await waitFor(() =>
      expect(calls.some((c) => /\/api\/costs\?from=\d{4}-\d{2}-\d{2}&to=/.test(c.url))).toBe(true),
    );
    expect(screen.getByTestId('costs-export').getAttribute('href')).toMatch(
      /\/api\/costs\/export\.csv\?from=.*&to=/,
    );
    const code = screen.getByTestId('currency-code');
    await user.clear(code);
    await user.type(code, 'eur');
    const rate = screen.getByTestId('currency-rate');
    await user.clear(rate);
    await user.type(rate, '0.9');
    await user.click(screen.getByTestId('currency-save'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ currency: 'EUR', usdRate: 0.9 }),
    );
  });

  it('says so when there is no spend, and shows the prices table in a disclosure', async () => {
    stub({
      '/api/costs': () =>
        report({
          totals: {
            costMicros: 0,
            shifts: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          byProject: [],
          byDay: [],
        }),
    });
    wrap(<Costs />);
    expect(await screen.findByText('No spend in this range')).toBeInTheDocument();
    expect(screen.getByTestId('costs-prices')).toBeInTheDocument();
  });

  it('shows the server error to someone who may not see costs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 'forbidden', message: 'admins only' } }, 403)),
    );
    wrap(<Costs />);
    expect(await screen.findByText(/admins only/)).toBeInTheDocument();
  });
});

describe('navigation', () => {
  it('lists the Org chart for everyone and Costs for Owner and Admin only', () => {
    const labels = (canManage: boolean) =>
      buildNav({ projectKey: null, canManage }).sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels(false)).toContain('Org chart');
    expect(labels(false)).not.toContain('Costs');
    expect(labels(true)).toContain('Costs');
    const org = buildNav({ projectKey: null, canManage: true }).sections.find(
      (s) => s.label === 'Organization',
    );
    expect(org?.items.map((i) => i.label).slice(0, 2)).toEqual(['Agents', 'Org chart']);
  });
});

describe('the desk notice of a paused project', () => {
  const item = (over: Partial<DeskItemDto> = {}): DeskItemDto =>
    ({
      id: U(50),
      kind: 'alert',
      subkind: 'budget_paused',
      status: 'open',
      routedTo: 'manager',
      title: 'TOY is paused: its monthly budget is used up',
      body: 'TOY has spent $12.00 of its $10.00 budget this month.',
      doing: '',
      options: [
        { id: 'raise', label: 'Raise budget' },
        { id: 'override', label: 'Override for this month' },
      ],
      recommendation: 'raise',
      blocking: false,
      pinned: true,
      urgent: false,
      affectedCardIds: [],
      affectedCount: 0,
      askedBy: { kind: 'system' },
      card: null,
      projectId: null,
      dedupEntries: [],
      answer: null,
      answerOption: null,
      answeredAt: null,
      answeredByName: null,
      decisionPolicy: null,
      canAnswer: true,
      budgetProject: { projectId: U(5), projectKey: 'TOY' },
      createdAt: '2026-10-07T06:00:00.000Z',
      ...over,
    }) as DeskItemDto;

  it('offers Raise budget (to the settings) and Override for this month (a call)', async () => {
    const user = userEvent.setup();
    const calls = stub();
    wrap(<DeskItem item={item()} />);
    expect(screen.getByTestId('desk-kind')).toHaveTextContent('Budget paused');
    await user.click(screen.getByTestId('desk-budget-override'));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith(`/api/projects/${U(5)}/budget/override`))).toBe(true),
    );
    await user.click(screen.getByTestId('desk-budget-raise'));
    expect(await screen.findByTestId('elsewhere')).toBeInTheDocument();
  });
});
