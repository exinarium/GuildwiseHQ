import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { Login } from '../pages/Login.tsx';
import { OwnershipTransfer } from '../pages/OwnershipTransfer.tsx';
import { PlatformOrgDetail } from '../pages/platform/PlatformOrgDetail.tsx';
import { PlatformTeam } from '../pages/platform/PlatformTeam.tsx';
import { PlatformUsers } from '../pages/platform/PlatformUsers.tsx';
import { RecoverTwoFactor } from '../pages/RecoverTwoFactor.tsx';

/** R17 in the web app: the recovery and transfer consent pages, and what the platform console no longer offers. */

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-21T10:00:00.000Z';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (method: string, url: string, body: any) => Response | undefined;
const calls: Array<{ method: string; url: string; body: any }> = [];
let handler: Handler = () => undefined;

beforeEach(() => {
  calls.length = 0;
  handler = () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url.includes('/api/auth/me')) return json({ error: { code: 'unauthorized', message: 'no' } }, 401);
      return handler(method, url, body) ?? json({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const wrap = (path: string, routes: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
    >
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>{routes}</Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('"Lost your authenticator?" on the two-factor step', () => {
  it('starts a recovery with the sign-in challenge and says to check the mail', async () => {
    handler = (method, url) => {
      if (method === 'POST' && url === '/api/auth/login')
        return json({ twoFactorRequired: true, challenge: 'c'.repeat(43), methods: ['totp', 'recovery'] });
      if (method === 'POST' && url === '/api/auth/2fa/recovery/start')
        return json({ state: 'awaiting_confirmation', effectiveAt: null });
      return undefined;
    };
    const user = userEvent.setup();
    wrap('/login', <Route path="/login" element={<Login />} />);
    await user.type(await screen.findByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'Password-12345');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(await screen.findByRole('button', { name: /Lost your authenticator/ }));
    expect(await screen.findByText(/Check your mail/)).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/api/auth/2fa/recovery/start')?.body).toEqual({
      challenge: 'c'.repeat(43),
    });
  });
});

describe('the recovery page', () => {
  it('reads the token from the fragment, confirms, then offers only cancel during the wait', async () => {
    window.location.hash = '#tok-0123456789abcdef';
    let state = 'awaiting_confirmation';
    handler = (method, url) => {
      if (method !== 'POST') return undefined;
      if (url === '/api/auth/2fa/recovery/status') return json({ state, effectiveAt: null });
      if (url === '/api/auth/2fa/recovery/confirm') {
        state = 'waiting';
        return json({ state, effectiveAt: '2026-11-22T10:00:00.000Z' });
      }
      return undefined;
    };
    const user = userEvent.setup();
    wrap('/recover-2fa', <Route path="/recover-2fa" element={<RecoverTwoFactor />} />);
    await user.click(await screen.findByTestId('recover-2fa-confirm'));
    expect(await screen.findByText(/Waiting 24 hours/)).toBeInTheDocument();
    expect(screen.queryByTestId('recover-2fa-confirm')).toBeNull();
    expect(screen.getByTestId('recover-2fa-cancel').textContent).toMatch(/this was not me/);
    // the token goes in the body, never in a URL
    expect(calls.filter((c) => c.url.includes('tok-0123'))).toEqual([]);
    expect(calls.find((c) => c.url === '/api/auth/2fa/recovery/confirm')?.body).toEqual({
      token: 'tok-0123456789abcdef',
    });
  });

  it('shows a finished recovery as such', async () => {
    window.location.hash = '#tok-0123456789abcdef';
    handler = (method, url) =>
      method === 'POST' && url === '/api/auth/2fa/recovery/status'
        ? json({ state: 'cancelled', effectiveAt: null })
        : undefined;
    wrap('/recover-2fa', <Route path="/recover-2fa" element={<RecoverTwoFactor />} />);
    expect(await screen.findByText('This recovery was cancelled')).toBeInTheDocument();
  });
});

const transfer = (over: Record<string, unknown> = {}) => ({
  id: ID(5),
  orgId: ID(10),
  orgName: 'Acme',
  toUser: { id: ID(2), displayName: 'Adam Admin', email: 'adam@acme.test' },
  reason: 'support case 42',
  requestedAt: T,
  effectiveAt: '2026-11-28T10:00:00.000Z',
  automatic: true,
  decision: null,
  decidedAt: null,
  ...over,
});

describe('the Owner’s transfer consent page', () => {
  it('shows the request and approves it', async () => {
    let decided = false;
    handler = (method, url) => {
      if (url === `/api/org/ownership-transfers/${ID(5)}`)
        return json(transfer(decided ? { decision: 'approved', decidedAt: T } : {}));
      if (method === 'POST' && url === `/api/org/ownership-transfers/${ID(5)}/approve`) {
        decided = true;
        return json(transfer({ decision: 'approved', decidedAt: T }));
      }
      return undefined;
    };
    const user = userEvent.setup();
    wrap(`/org-transfer/${ID(5)}`, <Route path="/org-transfer/:id" element={<OwnershipTransfer />} />);
    expect(await screen.findByText(/support case 42/)).toBeInTheDocument();
    expect(screen.getByText(/If you do nothing, it takes effect/)).toBeInTheDocument();
    await user.click(screen.getByTestId('ownership-transfer-approve'));
    expect((await screen.findByTestId('ownership-transfer-decision')).textContent).toBe('approved');
  });

  it('says nothing happens without approval for an organization with deploy targets', async () => {
    handler = (_m, url) =>
      url === `/api/org/ownership-transfers/${ID(5)}` ? json(transfer({ automatic: false })) : undefined;
    wrap(`/org-transfer/${ID(5)}`, <Route path="/org-transfer/:id" element={<OwnershipTransfer />} />);
    expect(await screen.findByText(/nothing happens unless you approve it/)).toBeInTheDocument();
  });
});

describe('the platform console after R17', () => {
  it('shows the platform team designation read-only, and warns about a legacy one', async () => {
    handler = (_m, url) =>
      url === '/api/platform/team'
        ? json({
            orgId: ID(10),
            orgName: 'Guildwise',
            projectId: ID(11),
            projectKey: 'PLT',
            projectName: 'Platform',
            updatedAt: T,
            source: 'legacy',
          })
        : undefined;
    wrap('/platform/team', <Route path="/platform/team" element={<PlatformTeam />} />);
    expect(await screen.findByTestId('platform-team-legacy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Designate' })).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/api/platform-team/'))).toBe(false);
  });

  it('offers no two-factor reset on the accounts page', async () => {
    handler = (_m, url) =>
      url.startsWith('/api/platform/users')
        ? json({
            users: [
              {
                id: ID(3),
                email: 'u@x.test',
                displayName: 'Uma User',
                status: 'active',
                kind: 'user',
                orgCount: 1,
                ownedOrgs: [],
                twoFactorEnabled: true,
                createdAt: T,
                lastLoginAt: null,
                passwordResetSentAt: null,
              },
            ],
          })
        : undefined;
    wrap('/platform/users', <Route path="/platform/users" element={<PlatformUsers />} />);
    expect(await screen.findByText('Uma User')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reset 2FA/ })).toBeNull();
  });

  it('shows a pending ownership transfer on the organization', async () => {
    handler = (_m, url) =>
      url === `/api/platform/orgs/${ID(10)}`
        ? json({
            id: ID(10),
            name: 'Acme',
            owner: { id: ID(1), displayName: 'Olga Owner', email: 'olga@acme.test' },
            memberCount: 3,
            status: 'active',
            statusReason: null,
            plan: 'founding',
            planName: 'Founding',
            limits: { maxMembers: null, maxWorkstations: null, maxAgents: null, maxProjects: null },
            usage: { members: 3, projects: 1, agents: 2, workstations: 1 },
            trialEndsAt: null,
            licenseExpiresAt: null,
            requireTwoFactor: false,
            simulation: false,
            simulationPace: 'normal',
            createdAsSimulation: false,
            createdAt: T,
            lastActiveAt: null,
            features: {},
            featureOverrides: {},
            graceDays: 7,
            billing: { provider: null, customerRef: null, subscriptionRef: null },
            shifts30d: 0,
            admins: [{ id: ID(2), displayName: 'Adam Admin', email: 'adam@acme.test' }],
            recentAudit: [],
            pendingTransfer: transfer(),
          })
        : undefined;
    wrap(`/platform/orgs/${ID(10)}`, <Route path="/platform/orgs/:id" element={<PlatformOrgDetail />} />);
    await waitFor(() =>
      expect(screen.getByTestId('platform-org-pending-transfer').textContent).toMatch(
        /unless the Owner vetoes it/,
      ),
    );
    expect(screen.getByRole('button', { name: 'Request ownership transfer' })).toBeInTheDocument();
  });
});
