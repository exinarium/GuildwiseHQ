import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { PlatformInvitations } from '../pages/platform/PlatformInvitations.tsx';
import { PlatformOrgDetail } from '../pages/platform/PlatformOrgDetail.tsx';
import { PlatformOrgs } from '../pages/platform/PlatformOrgs.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const T = '2026-10-06T10:00:00.000Z';
let sim = false;
const org = (status: 'active' | 'suspended' = 'active') => ({
  id: ID(10),
  name: 'Acme',
  owner: { id: ID(1), displayName: 'Olga Owner', email: 'olga@acme.test' },
  memberCount: 3,
  status,
  statusReason: null,
  plan: 'founding',
  planName: 'Founding',
  limits: { maxMembers: null, maxWorkstations: null, maxAgents: null, maxProjects: null },
  usage: { members: 3, projects: 1, agents: 2, workstations: 1 },
  trialEndsAt: null,
  licenseExpiresAt: null,
  requireTwoFactor: false,
  simulation: sim,
  simulationPace: 'normal',
  createdAt: T,
  lastActiveAt: null,
});
const detail = (status: 'active' | 'suspended' = 'active') => ({
  ...org(status),
  features: { interests: true },
  featureOverrides: {},
  graceDays: 7,
  billing: { provider: null, customerRef: null, subscriptionRef: null },
  shifts30d: 12,
  admins: [{ id: ID(2), displayName: 'Adam Admin', email: 'adam@acme.test' }],
  recentAudit: [],
});

const calls: Array<{ method: string; url: string; body: unknown }> = [];
let current: 'active' | 'suspended' = 'active';
beforeEach(() => {
  calls.length = 0;
  current = 'active';
  sim = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith('/api/platform/orgs?')) return json({ orgs: [org(current)] });
      if (method === 'PUT' && url.endsWith('/simulation')) {
        sim = (init.body ? JSON.parse(String(init.body)) : {}).enabled;
        return json(detail(current));
      }
      if (method === 'POST' && url.endsWith('/wipe-simulation'))
        return json({
          orgName: 'Acme',
          deletedUsers: ['olga@acme.test'],
          keptUsers: [],
          counts: {},
          backupNote: '',
        });
      if (method === 'POST' && url.endsWith('/suspend')) {
        current = 'suspended';
        return json(detail('suspended'));
      }
      if (url === `/api/platform/orgs/${ID(10)}/billing`)
        return json({ orgId: ID(10), mode: 'free', subscription: null, invoices: [], plans: [] });
      if (url === `/api/platform/orgs/${ID(10)}`) return json(detail(current));
      if (method === 'POST' && url === '/api/platform/invitations') return json({ id: ID(30) }, 201);
      if (url === '/api/platform/invitations') return json({ invitations: [] });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (path: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/platform" element={<PlatformOrgs />} />
            <Route path="/platform/orgs/:id" element={<PlatformOrgDetail />} />
            <Route path="/platform/invitations" element={<PlatformInvitations />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('platform area', () => {
  it('lists organizations with owner and status', async () => {
    wrap('/platform');
    expect(await screen.findByText('Acme')).toBeTruthy();
    expect(screen.getByText('olga@acme.test')).toBeTruthy();
    expect(screen.getAllByText('active').length).toBeGreaterThan(1);
  });

  it('suspends an organization only with a reason', async () => {
    const user = userEvent.setup();
    wrap(`/platform/orgs/${ID(10)}`);
    await user.click(await screen.findByRole('button', { name: 'Suspend' }));
    const confirm = screen.getAllByRole('button', { name: 'Suspend' }).at(-1) as HTMLElement;
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText(/Reason/), 'Invoice unpaid');
    await user.click(confirm);
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'POST' &&
            c.url.endsWith('/suspend') &&
            (c.body as { reason: string }).reason === 'Invoice unpaid',
        ),
      ).toBe(true),
    );
    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeTruthy();
  });

  it('invites a new organization on the Founding plan', async () => {
    const user = userEvent.setup();
    wrap('/platform/invitations');
    await user.type(await screen.findByLabelText('Owner email'), 'new@acme.test');
    await user.type(screen.getByLabelText('Organization name'), 'Newco');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url === '/api/platform/invitations');
      expect(c?.body).toMatchObject({ email: 'new@acme.test', proposedOrgName: 'Newco', plan: 'founding' });
    });
  });

  it('switches simulation on and asks for the typed name before deleting a simulation organization', async () => {
    const user = userEvent.setup();
    wrap(`/platform/orgs/${ID(10)}`);
    // off: no delete button
    const toggle = await screen.findByTestId('simulation-toggle');
    expect(screen.queryByTestId('simulation-wipe')).toBeNull();
    await user.click(toggle);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PUT' && (c.body as { enabled: boolean }).enabled === true)).toBe(
        true,
      ),
    );
    // on: the delete button opens a dialog that needs the name
    expect(await screen.findByTestId('simulation-wipe')).toBeTruthy();
    await user.click(screen.getByTestId('simulation-wipe'));
    const confirm = (await screen.findByTestId('simulation-wipe-confirm')) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(screen.getByTestId('simulation-wipe-name'), 'Acm');
    expect(confirm.disabled).toBe(true);
    await user.type(screen.getByTestId('simulation-wipe-name'), 'e');
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'POST' &&
            c.url.endsWith('/wipe-simulation') &&
            (c.body as { confirmName: string }).confirmName === 'Acme',
        ),
      ).toBe(true),
    );
  });

  it('marks simulation organizations in the list and can invite one', async () => {
    const user = userEvent.setup();
    sim = true;
    const { unmount } = wrap('/platform');
    expect(await screen.findByTestId('simulation-badge')).toBeTruthy();
    unmount();
    wrap('/platform/invitations');
    await user.type(await screen.findByLabelText('Owner email'), 'wife@acme.test');
    await user.type(screen.getByLabelText('Organization name'), 'Test Co');
    await user.click(screen.getByTestId('new-org-simulation'));
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url === '/api/platform/invitations');
      expect(c?.body).toMatchObject({ proposedOrgName: 'Test Co', simulation: true });
    });
  });
});
