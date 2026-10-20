import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeployTargetsPanel, deploysFrom } from '../components/DeployTargetsPanel.tsx';
import { ToastProvider } from '../components/ui.tsx';

const U = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('DeployTargetsPanel', () => {
  it('lists every project member workstation for a remote host', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/workstations'))
        return json({
          workstations: [
            {
              id: U(1),
              name: 'Desk',
              ownerId: U(9),
              ownerName: 'Ann',
              mine: true,
              connected: true,
              hasDevops: true,
            },
            {
              id: U(2),
              name: 'Laptop',
              ownerId: U(8),
              ownerName: 'Bob',
              mine: false,
              connected: false,
              hasDevops: false,
            },
          ],
        });
      return json({ targets: [] });
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DeployTargetsPanel projectId={U(5)} />
      </QueryClientProvider>,
    );
    await userEvent.selectOptions(screen.getByLabelText('Where does it run?'), 'remote_ssh');
    const select = await screen.findByLabelText('Workstation that deploys');
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(3));
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent?.replace(/\s+/g, ' '));
    expect(labels[1]).toBe('Desk (yours)');
    expect(labels[2]).toBe('Laptop (Bob), no DevOps engineer, offline');
  });

  const WS_LIST = [
    {
      id: U(1),
      name: 'Office PC',
      ownerId: U(9),
      ownerName: 'Ann',
      mine: true,
      connected: true,
      hasDevops: true,
    },
    {
      id: U(2),
      name: 'Old laptop',
      ownerId: U(8),
      ownerName: 'Bob',
      mine: false,
      connected: false,
      hasDevops: true,
    },
  ];
  const target = (over: Record<string, unknown> = {}) => ({
    id: U(30),
    projectId: U(5),
    name: 'shop-uat',
    kind: 'local_docker',
    workstationId: U(1),
    workstationName: 'Office PC',
    host: null,
    appUrl: 'http://localhost:8080',
    notes: '',
    createdAt: new Date().toISOString(),
    production: false,
    ...over,
  });
  const serve = (targets: unknown[], extra?: (url: string, init: RequestInit) => Response | undefined) =>
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const r = extra?.(String(url), init);
      if (r) return r;
      if (String(url).endsWith('/workstations')) return json({ workstations: WS_LIST });
      return json({ targets });
    });
  const mount = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <DeployTargetsPanel projectId={U(5)} />
        </ToastProvider>
      </QueryClientProvider>,
    );

  it('shows the production badge and where a target deploys from, with the computer online or offline', async () => {
    serve([
      target(),
      target({
        id: U(31),
        name: 'live',
        production: true,
        workstationId: U(2),
        workstationName: 'Old laptop',
      }),
      target({ id: U(32), name: 'any', workstationId: null, workstationName: null }),
    ]);
    mount();
    const uat = await screen.findByTestId('deploy-target-shop-uat');
    expect(uat).toHaveTextContent('Deploys from: Office PC (online)');
    expect(uat.querySelector('[data-testid="target-production-badge"]')).toBeNull();
    const live = screen.getByTestId('deploy-target-live');
    expect(live).toHaveTextContent('Production');
    expect(live).toHaveTextContent('Deploys from: Old laptop (offline)');
    expect(screen.getByTestId('deploy-target-any')).toHaveTextContent(
      'Deploys from: any computer of the project',
    );
  });

  it('adds a production target on a chosen computer: the checkbox and the workstation travel with the request', async () => {
    const user = userEvent.setup();
    serve([], (_url, init) => (init.method === 'POST' ? json(target({ production: true }), 201) : undefined));
    mount();
    await user.type(screen.getByLabelText('Name'), 'live');
    const where = await screen.findByLabelText('Which computer?');
    await waitFor(() => expect(where.querySelectorAll('option')).toHaveLength(3));
    await user.selectOptions(where, U(1));
    expect(
      screen.getByText(/Production is never used for tests, and every release needs your approval/),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId('target-production-checkbox'));
    await user.click(screen.getByRole('button', { name: 'Add deploy target' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true));
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST');
    expect(JSON.parse(post?.[1].body)).toMatchObject({
      name: 'live',
      kind: 'local_docker',
      workstationId: U(1),
      production: true,
    });
  });

  it('a server needs a computer and a host; the production box defaults to off', async () => {
    const user = userEvent.setup();
    serve([]);
    mount();
    expect(screen.getByTestId('target-production-checkbox')).not.toBeChecked();
    await user.type(screen.getByLabelText('Name'), 'vps');
    await user.selectOptions(screen.getByLabelText('Where does it run?'), 'remote_ssh');
    await user.click(screen.getByRole('button', { name: 'Add deploy target' }));
    expect(await screen.findByText('Choose the workstation that deploys')).toBeInTheDocument();
    expect(screen.getByText('An SSH host alias is required')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
  });

  it('Edit changes the production flag and the computer of an existing target', async () => {
    const user = userEvent.setup();
    serve([target()], (_url, init) =>
      init.method === 'PATCH' ? json(target({ production: true, workstationId: U(2) })) : undefined,
    );
    mount();
    await user.click(await screen.findByRole('button', { name: 'Edit deploy target shop-uat' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('target-production-checkbox')).not.toBeChecked();
    await user.click(within(dialog).getByTestId('target-production-checkbox'));
    await user.selectOptions(within(dialog).getByLabelText('Which computer?'), U(2));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true));
    const patch = fetchMock.mock.calls.find(([, i]) => i?.method === 'PATCH');
    expect(patch?.[0]).toBe(`/api/deploy-targets/${U(30)}`);
    expect(JSON.parse(patch?.[1].body)).toMatchObject({ production: true, workstationId: U(2) });
  });

  it('deploysFrom without a computer says so', () => {
    expect(deploysFrom({ kind: 'remote_ssh', workstationId: null, workstationName: null }, []).text).toBe(
      'not set',
    );
  });
});
