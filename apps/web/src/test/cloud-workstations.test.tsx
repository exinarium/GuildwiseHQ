import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { Workstations } from '../pages/Workstations.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let cloud: unknown[] = [];
let hasDocker = true;
let calls: Array<{ method: string; url: string; body?: unknown }> = [];
const dto = (over: Record<string, unknown> = {}) => ({
  id: ID(50),
  provider: 'codespaces',
  name: 'Cloud desk',
  projectId: null,
  state: 'stopped',
  stateDetail: 'Stopped (idle)',
  workstationId: ID(60),
  connected: false,
  idleMinutes: 30,
  officeHours: null,
  authMode: 'api_key',
  location: 'acme/site (basicLinux32gb)',
  manualPower: false,
  canDeployDocker: false,
  monthlyEstimateUsd: 33.12,
  estimateBasis: 'About 176 running hours a month.',
  lastActivityAt: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  ...over,
});

beforeEach(() => {
  cloud = [];
  hasDocker = true;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url === '/api/auth/me')
        return json({
          user: {
            id: ID(1),
            email: 'me@example.test',
            displayName: 'Me',
            role: 'admin',
            status: 'active',
            createdAt: '2026-10-01T10:00:00.000Z',
            lastLoginAt: null,
          },
          isAdmin: true,
          visibleProjectIds: [],
          features: { mockUi: false },
          activeOrg: { id: ID(2), name: 'Acme', role: 'owner' },
        });
      if (url === '/api/workstations') return json({ workstations: [] });
      if (url === '/api/cloud-workstations')
        return json({ cloudWorkstations: cloud, hasDockerCapableWorkstation: hasDocker });
      if (url === '/api/cloud-workstations/github/connection') return json({ connected: false, login: null });
      if (method === 'POST' && url.endsWith('/wake')) return json(dto({ state: 'starting' }));
      return json({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <Workstations />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('cloud workstations', () => {
  it('shows status, the monthly estimate and wakes a sleeping codespace', async () => {
    cloud = [dto()];
    const user = userEvent.setup();
    wrap();
    const card = await screen.findByTestId('cloud-Cloud desk');
    expect(card).toHaveTextContent('Asleep');
    expect(screen.getByTestId('cloud-estimate')).toHaveTextContent('$33.12 a month');
    expect(card).toHaveTextContent('30 minutes without work');
    await user.click(screen.getByRole('button', { name: /Wake/ }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url === `/api/cloud-workstations/${ID(50)}/wake`),
      ).toBe(true),
    );
  });

  it('tells the user a Codespace cannot deploy Docker when nothing else can', async () => {
    cloud = [dto()];
    hasDocker = false;
    wrap();
    expect(await screen.findByTestId('docker-notice')).toHaveTextContent('workstation of yours or a VPS');
  });

  it('shows the sign-in step for a VPS and no wake or stop buttons', async () => {
    cloud = [
      dto({
        provider: 'ssh',
        name: 'Studio VPS',
        state: 'running',
        stateDetail: '',
        manualPower: true,
        canDeployDocker: true,
        location: 'deploy@203.0.113.9:22',
        monthlyEstimateUsd: 12,
      }),
    ];
    wrap();
    const card = await screen.findByTestId('cloud-Studio VPS');
    expect(screen.getByTestId('vps-next-step')).toHaveTextContent('aom-runner auth api-key');
    expect(card).not.toHaveTextContent('Wake');
    expect(screen.queryByTestId('docker-notice')).toBeNull();
  });

  it('offers Local, VPS and Codespaces in Add a workstation, with the individual-use warning', async () => {
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByTestId('add-workstation-empty'));
    expect(await screen.findByTestId('where-local')).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByTestId('where-vps'));
    expect(await screen.findByTestId('add-vps')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-auth')).toBeInTheDocument();
    expect(screen.queryByTestId('individual-use-warning')).toBeNull();
    await user.click(screen.getByLabelText(/With my Claude subscription/));
    expect(screen.getByTestId('individual-use-warning')).toBeInTheDocument();
    await user.click(screen.getByTestId('where-codespaces'));
    expect(await screen.findByTestId('add-codespace')).toHaveTextContent('cannot run Docker');
  });
});
