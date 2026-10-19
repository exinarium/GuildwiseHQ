import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphContextPanel } from '../components/GraphContextPanel.tsx';

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const arm = (cards: number, median: number | null) => ({
  cards,
  median,
  p25: median && median * 0.9,
  p75: median && median * 1.1,
});
const dis = (bytes: number | null) => ({ medianBytes: bytes, medianCalls: bytes && 12, medianGraphCalls: 3 });
const guards = {
  reworkRounds: 0.5,
  changesRequested: 0.4,
  testerFailures: 0.2,
  daysToDone: 2,
  costPerCardUsd: 3,
};

let report: Record<string, unknown>;
beforeEach(() => {
  report = {
    evaluating: false,
    windowEndsAt: '2026-11-01T00:00:00.000Z',
    on: arm(30, 70_000),
    off: arm(30, 100_000),
    interval: { ratio: 0.7, lo: 0.6, hi: 0.8 },
    guards: { on: guards, off: guards },
    discovery: { on: dis(20_000), off: dis(80_000) },
    claim: { allowed: true, reason: 'ok', savingPercent: 30, worseGuards: [] },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (url === '/api/value/graph' ? json(report) : json({}))),
  );
});
afterEach(() => vi.unstubAllGlobals());

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GraphContextPanel />
    </QueryClientProvider>,
  );

describe('GraphContextPanel (the measured saving, numbers only)', () => {
  it('states the saving and its range only when the claim is allowed, with both groups side by side', async () => {
    mount();
    expect(await screen.findByTestId('graph-claim')).toHaveTextContent('30% fewer billed input tokens');
    expect(screen.getByTestId('graph-claim')).toHaveTextContent('20% to 40%');
    const rows = screen.getByTestId('graph-arms').querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('With the map');
    expect(rows[0]).toHaveTextContent('30');
    expect(rows[1]).toHaveTextContent('Without it');
  });

  it('says why when it is not allowed, and names a worse quality measure', async () => {
    report = {
      ...report,
      claim: { allowed: false, reason: 'guard_worse', savingPercent: null, worseGuards: ['testerFailures'] },
    };
    mount();
    const t = await screen.findByTestId('graph-claim-none');
    expect(t).toHaveTextContent('did worse on a quality measure');
    expect(t).toHaveTextContent('tester failures per card');
    expect(screen.queryByTestId('graph-claim')).toBeNull();
  });

  it('is not there before anything was measured, and not there when the server has no such report', async () => {
    report = {
      ...report,
      evaluating: false,
      on: arm(0, null),
      off: arm(0, null),
      interval: null,
      claim: { allowed: false, reason: 'not_enough_cards', savingPercent: null, worseGuards: [] },
    };
    const { container } = mount();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe('');
  });
});
