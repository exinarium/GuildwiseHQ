import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workstations } from '../pages/Workstations.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ORG = ID(900);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Folders = {
  folders: Array<{ orgId: string; folder: string; valid: boolean; reason: string | null; repoCount: number }>;
  errors: Record<string, string>;
  candidates: string[];
  checkedAt: string | null;
};
let owner = ID(1);
let orgFolders: Folders;
const puts: Array<{ url: string; body: unknown }> = [];

const ws = () => ({
  id: ID(10),
  userId: owner,
  name: 'Desk',
  platform: 'linux',
  hostname: 'desk.lan',
  runnerVersion: '1.0.0',
  status: 'active',
  connected: true,
  lastSeenAt: '2026-10-06T10:00:00.000Z',
  runtimes: [],
  repos: [],
  pairedAt: '2026-10-01T10:00:00.000Z',
  orgFolders,
});

beforeEach(() => {
  owner = ID(1);
  puts.length = 0;
  localStorage.clear();
  localStorage.setItem('aom-workstations-open-anon', '[]');
  orgFolders = {
    folders: [],
    errors: {},
    candidates: ['/home/me/src/acme', '/home/me/src/other'],
    checkedAt: '2026-10-06T10:00:00.000Z',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (url === '/api/auth/me')
        return json({
          user: {
            id: ID(1),
            email: 'me@example.test',
            displayName: 'Me',
            role: 'member',
            status: 'active',
            createdAt: '2026-10-01T10:00:00.000Z',
            lastLoginAt: null,
          },
          isAdmin: false,
          visibleProjectIds: [],
          features: { mockUi: false },
          activeOrg: {
            id: ORG,
            name: 'Acme',
            status: 'active',
            role: 'owner',
            banners: [],
            plan: 'x',
            planName: 'X',
            features: {},
          },
        });
      if (url === '/api/workstations') return json({ workstations: [ws()] });
      if (method === 'PUT' && url.endsWith('/org-folder')) {
        puts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ ok: true }, 202);
      }
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const open = async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Workstations />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const card = await screen.findByTestId('workstation-Desk');
  await user.click(within(card).getByRole('button', { name: 'Show details of Desk' }));
  return { user, card };
};

describe('Organisation source folder row', () => {
  it('shows "not set" with the explanation and sets a typed path', async () => {
    const { user, card } = await open();
    const row = await within(card).findByTestId('org-folder');
    expect(within(row).getByTestId('org-folder-path')).toHaveTextContent('not set');
    expect(row).toHaveTextContent(
      'The architect may read every repository in this folder, read-only; secret files stay blocked.',
    );
    await user.type(within(row).getByLabelText('Folder path'), '/home/me/src/acme');
    await user.click(within(row).getByRole('button', { name: 'Set folder' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({
      url: `/api/workstations/${ID(10)}/org-folder`,
      body: { orgId: ORG, path: '/home/me/src/acme' },
    });
  });

  it('picks a candidate folder the runner reported', async () => {
    const { user, card } = await open();
    const row = await within(card).findByTestId('org-folder');
    await user.selectOptions(within(row).getByLabelText('Folders on this workstation'), '/home/me/src/other');
    expect(within(row).getByLabelText('Folder path')).toHaveValue('/home/me/src/other');
    await user.click(within(row).getByRole('button', { name: 'Set folder' }));
    await waitFor(() => expect(puts[0]?.body).toEqual({ orgId: ORG, path: '/home/me/src/other' }));
  });

  it('shows the current folder, its repository count and status, and clears it', async () => {
    orgFolders.folders = [
      { orgId: ORG, folder: '/home/me/src/acme', valid: true, reason: null, repoCount: 3 },
    ];
    const { user, card } = await open();
    const row = await within(card).findByTestId('org-folder');
    expect(within(row).getByTestId('org-folder-path')).toHaveTextContent('/home/me/src/acme');
    expect(within(row).getByTestId('org-folder-repos')).toHaveTextContent('3 repositories');
    expect(within(row).getByTestId('org-folder-status')).toHaveTextContent('ok');
    await user.click(within(row).getByRole('button', { name: /Clear the organisation source folder/ }));
    await waitFor(() => expect(puts[0]?.body).toEqual({ orgId: ORG, path: null }));
  });

  it('shows why a folder is invalid and why the workstation refused a path', async () => {
    orgFolders.folders = [
      {
        orgId: ORG,
        folder: '/home/me/src/gone',
        valid: false,
        reason: '/home/me/src/gone does not exist',
        repoCount: 0,
      },
    ];
    orgFolders.errors = { [ORG]: "/etc must be a folder inside one of the runner's repoRoots" };
    const { card } = await open();
    const row = await within(card).findByTestId('org-folder');
    expect(within(row).getByTestId('org-folder-status')).toHaveTextContent('invalid');
    expect(within(row).getByTestId('org-folder-reason')).toHaveTextContent('does not exist');
    expect(within(row).getByTestId('org-folder-refused')).toHaveTextContent('repoRoots');
  });

  it('is not shown on a workstation of someone else', async () => {
    owner = ID(2);
    const { card } = await open();
    await within(card).findByTestId('workstation-details');
    expect(within(card).queryByTestId('org-folder')).toBeNull();
  });
});
