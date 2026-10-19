import type { MeResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { Vaults } from '../pages/Vaults.tsx';

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const me = {
  user: { id: 'u1', email: 'a@b.test', displayName: 'A', kind: 'user', status: 'active', timezone: 'UTC' },
  account: { kind: 'user' },
  isAdmin: false,
  orgs: [{ id: 'o0', name: 'Org', role: 'owner', status: 'active' }],
  activeOrg: {
    id: 'o0',
    name: 'Org',
    role: 'owner',
    status: 'active',
    features: {},
    banners: [],
    gate: null,
  },
  guestIn: [],
  guestProjectIds: [],
  visibleProjectIds: [],
  pendingInvitations: 0,
  mustChangePassword: false,
  twoFactor: { enabled: false, required: false, setupRequired: false },
  features: { mockUi: false },
} as unknown as MeResponse;

const localVault = {
  id: '0192f3a0-0000-7000-8000-0000000000a1',
  orgId: '0192f3a0-0000-7000-8000-0000000000f1',
  projectId: '0192f3a0-0000-7000-8000-0000000000c1',
  kind: 'project',
  name: 'Project vault',
  remoteUrl: '',
  storage: 'local',
  syncIntervalSec: 300,
  createdAt: '2026-10-19T10:00:00.000Z',
  canEdit: true,
  workstations: [
    {
      workstationId: '0192f3a0-0000-7000-8000-0000000000b1',
      workstationName: 'Desk',
      localPath: '/home/me/.aom-runner/vaults/x',
      lastPullAt: null,
      lastPushAt: null,
      lastError: null,
      paused: false,
      conflictFiles: [],
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/me') return json(me);
      if (url === '/api/vaults') return json({ vaults: [localVault] });
      if (url === '/api/projects')
        return json({
          projects: [
            {
              id: localVault.projectId,
              key: 'TOY',
              name: 'Toy',
              myRole: 'owner',
              status: 'active',
              kind: 'project',
            },
          ],
        });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('Vaults page: local vaults (project-graphs design section 3)', () => {
  it('says the folder is not synced and must be backed up, and offers no URL edit', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter>
            <Vaults />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('local folder')).toBeTruthy();
    expect(screen.getByText(/not synced and has no copy anywhere else: back it up/i)).toBeTruthy();
    expect(screen.getByText('folder ready')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Edit /i })).toBeNull();
    // the project can still be given a git repository
    expect(screen.getByRole('button', { name: 'Register a vault' })).toBeTruthy();
  });
});
