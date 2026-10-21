import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseQueue } from '../components/delivery/ReleaseQueue.tsx';
import { ToastProvider } from '../components/ui.tsx';

const U = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('ReleaseQueue', () => {
  const item = (targets: string[], over: Record<string, unknown> = {}) => ({
    projectId: U(5),
    projectKey: 'P5',
    env: 'production',
    commit: 'abc1234567890',
    waitingFor: 'owner',
    requestedAt: new Date().toISOString(),
    gateNow: { satisfied: true, missing: [] },
    targets: targets.map((t, i) => ({
      runId: U(10 + i),
      targetId: U(20 + i),
      targetName: t,
      production: true,
      host: `h${i}`,
      workstationName: 'Desk',
    })),
    ...over,
  });

  it('offers a target choice when an environment has several servers: Release sends only the ticked runs', async () => {
    const posted: unknown[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/delivery/release')) {
        posted.push(JSON.parse(String(init?.body)));
        return json({ runs: [], message: 'released' });
      }
      return json({ items: [item(['p5-prod-1', 'p5-prod-2', 'p5-prod-3'])] });
    });
    wrap(<ReleaseQueue />);
    const row = await screen.findByTestId('release-P5-production');
    expect(within(row).getByText('abc1234567')).toBeTruthy();
    const button = within(row).getByTestId('release-P5-production-button') as HTMLButtonElement;
    // nothing is ticked by default for several servers: the Owner chooses
    expect(button.disabled).toBe(true);
    await userEvent.click(within(row).getByTestId('pick-p5-prod-2'));
    await userEvent.click(within(row).getByTestId('pick-p5-prod-3'));
    expect(button.textContent).toBe('Release to 2 of 3');
    await userEvent.click(button);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ runIds: [U(11), U(12)] });
  });

  it('a single server releases with one click, and a gate that no longer holds is said out loud', async () => {
    fetchMock.mockImplementation(async () =>
      json({
        items: [item(['p5-prod'], { gateNow: { satisfied: false, missing: ['releases are frozen'] } })],
      }),
    );
    wrap(<ReleaseQueue />);
    const row = await screen.findByTestId('release-P5-production');
    expect(within(row).queryByTestId('pick-p5-prod')).toBeNull();
    expect((within(row).getByTestId('release-P5-production-button') as HTMLButtonElement).textContent).toBe(
      'Release',
    );
    expect(row.textContent).toContain('releases are frozen');
  });

  it('says so when nothing waits', async () => {
    fetchMock.mockImplementation(async () => json({ items: [] }));
    wrap(<ReleaseQueue />);
    expect(await screen.findByTestId('release-queue-empty')).toBeTruthy();
  });
});
