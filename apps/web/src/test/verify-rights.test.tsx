import type { WorkstationDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevOpsPanel } from '../components/DevOpsPanel.tsx';

const U = '0192f3a0-0000-7000-8000-000000000001';
const WS_ID = '0192f3a0-0000-7000-8000-0000000000f1';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
    >
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock
    .mockReset()
    .mockImplementation(async (url: string) =>
      String(url).startsWith('/api/devops/requests') ? json({ requests: [] }) : json({ queued: true }, 202),
    );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ws = (over: Partial<WorkstationDto> = {}): WorkstationDto => ({
  id: WS_ID,
  userId: U,
  name: 'Desk',
  platform: 'linux',
  hostname: 'desk',
  runnerVersion: '0.1.0',
  status: 'active',
  connected: true,
  lastSeenAt: '2026-10-05T10:00:00.000Z',
  runtimes: [],
  repos: [],
  pairedAt: '2026-10-01T10:00:00.000Z',
  devopsAccess: { allowInstall: false, allowDocker: true, allowedPaths: [], sudo: false },
  rightsCheck: { state: 'idle', message: null, requestedAt: null },
  ...over,
});

describe('Verify now', () => {
  it('posts the check to the verify-rights route', async () => {
    const user = userEvent.setup();
    wrap(<DevOpsPanel w={ws()} />);
    await user.click(screen.getByRole('button', { name: 'Verify now' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((c) => c[0])).toContain(`/api/workstations/${WS_ID}/verify-rights`),
    );
  });

  it('shows "Verifying..." (disabled) while the server says checking', () => {
    wrap(
      <DevOpsPanel
        w={ws({ rightsCheck: { state: 'checking', message: null, requestedAt: '2026-10-05T10:00:00.000Z' } })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Verifying...' })).toBeDisabled();
    expect(screen.getByTestId('rights-checking')).toBeInTheDocument();
  });

  it.each([
    ['failed', 'docker binary vanished', 'The check failed: docker binary vanished'],
    ['timed_out', 'The runner did not answer.', 'The runner did not answer.'],
    ['unsupported', 'This runner (0.1.0) is too old to check rights.', 'too old to check rights'],
  ] as const)('shows a clear message for %s', (state, message, text) => {
    wrap(<DevOpsPanel w={ws({ rightsCheck: { state, message, requestedAt: null } })} />);
    expect(screen.getByTestId('rights-check-problem')).toHaveTextContent(text);
    // a runner that is too old cannot be asked; the others can be asked again
    expect(screen.getByRole('button', { name: 'Verify now' }).hasAttribute('disabled')).toBe(
      state === 'unsupported',
    );
  });

  it('shows the 409 message when the server refuses an outdated runner', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).startsWith('/api/devops/requests')
        ? json({ requests: [] })
        : json({ error: { code: 'runner_outdated', message: 'This workstation runner is too old.' } }, 409),
    );
    const user = userEvent.setup();
    wrap(<DevOpsPanel w={ws()} />);
    await user.click(screen.getByRole('button', { name: 'Verify now' }));
    expect(await screen.findByText(/runner is too old/)).toBeInTheDocument();
  });
});
