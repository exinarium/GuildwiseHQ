import type { ValueReport } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValuePanel, valueHeadline } from '../components/ValuePanel.tsx';

afterEach(() => vi.unstubAllGlobals());

const period = (month: string, over: Partial<ValueReport['current']> = {}): ValueReport['current'] => ({
  month,
  cards: 42,
  hours: 168,
  usageMicros: 84_000_000,
  valueMicros: 6_720_000_000,
  returnX: 80,
  agentHours: 20,
  reworkRounds: 3,
  avgDaysToDone: 2.5,
  ...over,
});
const report = (over: Partial<ValueReport> = {}): ValueReport => ({
  currency: 'USD',
  timezone: 'UTC',
  current: period('2026-10'),
  previous: period('2026-09', { cards: 30, hours: 120, usageMicros: 60_000_000 }),
  byType: [],
  byProject: [],
  nextActions: [
    { kind: 'stuck_card', title: 'WEB-3 Slow page', detail: 'blocked, no movement for 6 days', ref: 'WEB-3' },
    { kind: 'idle_project', title: 'OPS Ops', detail: 'No card activity for 14 days', ref: 'OPS' },
  ],
  settings: {
    hoursByType: { feature: 8, bug: 3, support: 1, refactor: 5, docs: 2, research: 4 },
    hourlyValue: null,
    hourlyValueEffective: 40,
    canEdit: true,
  },
  ...over,
});

function mount(r: ValueReport) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(r), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ValuePanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe('value panel', () => {
  it('words the headline as cards, hours, usage and return', () => {
    expect(valueHeadline(report())).toBe('42 cards, ~168 hours of work, $84.00 usage, ~80× return');
    expect(
      valueHeadline(
        report({ current: period('2026-10', { cards: 1, hours: 1, usageMicros: 0, returnX: null }) }),
      ),
    ).toBe('1 card, ~1 hour of work, $0.00 usage');
  });

  it('shows the headline, the trend, the next best actions and the CSV export', async () => {
    mount(report());
    expect(await screen.findByTestId('value-headline')).toHaveTextContent(
      'This month: 42 cards, ~168 hours of work, $84.00 usage, ~80× return',
    );
    expect(screen.getByTestId('value-trend')).toHaveTextContent('cards up 12 (30)');
    const actions = screen.getByTestId('value-actions');
    expect(actions).toHaveTextContent('WEB-3 Slow page');
    expect(actions.querySelector('a')?.getAttribute('href')).toBe('/cards/WEB-3');
    expect(screen.getByTestId('value-export').getAttribute('href')).toContain(
      '/api/value/export.csv?month=2026-10',
    );
  });

  it('saves adjusted estimates', async () => {
    const calls = mount(report());
    await userEvent.click(await screen.findByText('Adjust the estimates'));
    const feature = await screen.findByTestId('value-hours-feature');
    await userEvent.clear(feature);
    await userEvent.type(feature, '10');
    await userEvent.type(screen.getByTestId('value-rate'), '55');
    await userEvent.click(screen.getByTestId('value-save'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toContain('/api/value/settings');
    expect(put?.body).toMatchObject({ hourlyValue: 55, hoursByType: { feature: 10, bug: 3 } });
  });
});
