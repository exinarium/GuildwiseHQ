import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { OrgSettings } from '../pages/OrgSettings.tsx';

const ID = '0192f3a0-0000-7000-8000-000000000001';
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let calls: string[];
function setup(mode: 'business' | 'dev', role: 'owner' | 'member') {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const path = url.split('?')[0];
      if (path === '/api/auth/me')
        return json({
          user: { id: ID, email: 'o@x.test', displayName: 'Olga', kind: 'user', status: 'active' },
          account: { kind: 'user' },
          isAdmin: false,
          orgs: [{ id: ID, name: 'Org', role, status: 'active' }],
          activeOrg: { id: ID, name: 'Org', role, status: 'active', features: {}, mode, banners: [] },
          guestIn: [],
          guestProjectIds: [],
          visibleProjectIds: [],
          pendingInvitations: 0,
          twoFactor: { enabled: false, required: false, setupRequired: false },
          features: { mockUi: false },
        });
      if (path === '/api/org')
        return json({
          id: ID,
          name: 'Org',
          role,
          plan: 'founding',
          mode,
          owner: { userId: ID, name: 'Olga' },
          requireTwoFactor: false,
          diagnosticsSharing: false,
          diagnosticsSharingAvailable: false,
        });
      if (path === '/api/relay/integrations') return json({ integrations: [] });
      if (path === '/api/relay/integrations/status') return json({ statuses: [] });
      return json({});
    }),
  );
}
const open = (tab: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/settings/org${tab}`]}>
          <OrgSettings />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => undefined);

describe('the Inbound webhooks tab', () => {
  it('is there for a member of a business organization, read-only', async () => {
    setup('business', 'member');
    open('?tab=relay');
    expect(await screen.findByRole('tab', { name: 'Inbound webhooks' })).toBeInTheDocument();
    expect(await screen.findByTestId('relay-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('relay-new')).toBeNull();
  });
  it('lets the owner create', async () => {
    setup('business', 'owner');
    open('?tab=relay');
    expect(await screen.findByTestId('relay-new')).toBeInTheDocument();
  });
  it('is not there in a developer organization, and ?tab=relay shows General without any relay request', async () => {
    setup('dev', 'owner');
    open('?tab=relay');
    await screen.findByRole('tab', { name: 'General' });
    expect(screen.queryByRole('tab', { name: 'Inbound webhooks' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'General', selected: true })).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('relay-tab')).toBeNull();
    expect(calls.filter((c) => c.startsWith('/api/relay'))).toEqual([]);
  });
});
