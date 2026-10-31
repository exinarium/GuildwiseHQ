import type { MeResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRelayOfflineNotice } from '../api/queries/relay.ts';
import { OrgBanner } from '../components/shell/OrgBanner.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const me = (mode: 'business' | 'dev' = 'business') =>
  ({
    activeOrg: { id: ID(1), name: 'Org', role: 'member', status: 'active', mode, banners: [] },
    guestIn: [],
  }) as unknown as MeResponse;

const integration = {
  id: ID(5),
  orgId: ID(1),
  kind: 'whatsapp_cloud',
  label: 'Shop WhatsApp',
  status: 'active',
  createdAt: '2026-10-30T10:00:00.000Z',
  rotatedAt: null,
  revokedAt: null,
};
let status: Record<string, unknown>;
let calls: string[];
beforeEach(() => {
  calls = [];
  status = {
    integrationId: ID(5),
    connected: false,
    servingWorkstations: 0,
    everServed: true,
    offlineSince: '2026-10-31T09:00:00.000Z',
    refusedSinceOffline: { count: 1, lastAt: '2026-10-31T09:10:00.000Z' },
    lastEvent: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/relay/integrations') return json({ integrations: [integration] });
      if (url === '/api/relay/integrations/status') return json({ statuses: [status] });
      return json({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Shell({ mode = 'business' }: { mode?: 'business' | 'dev' }) {
  const m = me(mode);
  const notice = useRelayOfflineNotice(m.activeOrg);
  return <OrgBanner me={m} project={null} relayOffline={notice} />;
}
const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('OrgBanner relay notice', () => {
  it('stays hook-free: renders with no provider and shows the notice from its prop', () => {
    render(
      <MemoryRouter>
        <OrgBanner
          me={me()}
          project={null}
          relayOffline={{
            items: [
              {
                id: ID(5),
                label: 'Shop WhatsApp',
                kind: 'whatsapp_cloud',
                since: '2026-10-31T09:00:00.000Z',
                refused: 2,
              },
            ],
            retryText: 'The provider retries for up to 7 days.',
          }}
        />
      </MemoryRouter>,
    );
    const b = screen.getByTestId('relay-offline-banner');
    expect(b).toHaveTextContent('Runner offline: messages are waiting at the provider');
    expect(b).toHaveTextContent('Shop WhatsApp');
    expect(b).toHaveTextContent('up to 7 days');
    expect(screen.getByTestId('relay-offline-link')).toHaveAttribute('href', '/workstations');
  });
  it('shows nothing without the prop', () => {
    render(
      <MemoryRouter>
        <OrgBanner me={me()} project={null} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('relay-offline-banner')).toBeNull();
  });
});

describe('the live notice', () => {
  it('shows for offline plus a refused request, and clears on reconnect without a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wrap(<Shell />);
    expect(await screen.findByTestId('relay-offline-banner')).toHaveTextContent('Shop WhatsApp');
    status = {
      ...status,
      connected: true,
      servingWorkstations: 1,
      offlineSince: null,
      refusedSinceOffline: { count: 0, lastAt: null },
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    await waitFor(() => expect(screen.queryByTestId('relay-offline-banner')).toBeNull());
  });
  it('is not shown when offline with no refused request', async () => {
    status = { ...status, refusedSinceOffline: { count: 0, lastAt: null } };
    wrap(<Shell />);
    await waitFor(() => expect(calls).toContain('/api/relay/integrations/status'));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('relay-offline-banner')).toBeNull();
  });
  it('makes no relay request in a developer organization', async () => {
    wrap(<Shell mode="dev" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.startsWith('/api/relay'))).toEqual([]);
  });
});
