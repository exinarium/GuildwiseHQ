import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { detectOs, guideSteps, whatItDoes } from '../lib/installer-guide.ts';
import { Workstations } from '../pages/Workstations.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let workstations: unknown[] = [];
let status: Record<string, unknown>;
let created: Array<{ os: string; name?: string }> = [];
const session = (os: string) => ({
  id: ID(900 + created.length),
  os,
  expiresAt: '2026-10-07T09:00:00.000Z',
  oneLiner:
    os === 'windows'
      ? "irm 'https://hq.test/install/tok123/install.ps1' | iex"
      : "curl -fsSL 'https://hq.test/install/tok123/install.sh' | bash",
  downloadUrl: `https://hq.test/install/tok123/install.${os === 'windows' ? 'ps1' : 'sh'}?download=1`,
  fileName: os === 'windows' ? 'install-guildwise-hq.ps1' : 'install-guildwise-hq.sh',
  release: { version: '0.1.0', sha256: 'a'.repeat(64), size: 1000 },
});
const baseStatus = (state: string) => ({
  id: ID(901),
  os: 'linux',
  state,
  result: null,
  expiresAt: '2026-10-07T09:00:00.000Z',
  workstationId: null,
  workstationName: null,
  steps: [],
  doctor: [],
});

beforeEach(() => {
  created = [];
  workstations = [];
  status = baseStatus('waiting');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
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
            role: 'admin',
            status: 'active',
            createdAt: '2026-10-01T10:00:00.000Z',
            lastLoginAt: null,
          },
          isAdmin: true,
          visibleProjectIds: [],
          features: { mockUi: false },
        });
      if (url === '/api/workstations') return json({ workstations });
      if (method === 'POST' && url === '/api/workstations/installers') {
        const body = JSON.parse(String(init.body)) as { os: string; name?: string };
        created.push(body);
        return json(session(body.os), 201);
      }
      if (url.startsWith('/api/workstations/installers/')) return json(status);
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

describe('Add a workstation wizard', () => {
  it('opens from the empty state, detects the system and shows the one-line command', async () => {
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByTestId('add-workstation-empty'));
    expect(await screen.findByTestId('install-command')).toHaveTextContent(
      "curl -fsSL 'https://hq.test/install/tok123/install.sh' | bash",
    );
    expect(created).toEqual([{ os: 'linux' }]);
    expect(screen.getByTestId('os-linux')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('linux-flavours')).toBeInTheDocument();
    expect(screen.getByTestId('download-script')).toHaveAttribute(
      'href',
      'https://hq.test/install/tok123/install.sh?download=1',
    );
    expect(screen.getByTestId('download-script')).toHaveAttribute('download', 'install-guildwise-hq.sh');
    expect(screen.getByTestId('install-progress')).toHaveAttribute('data-state', 'waiting');
  });

  it('copies the command with a button', async () => {
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByTestId('add-workstation-empty'));
    await screen.findByTestId('install-command');
    await user.click(screen.getByTestId('copy-install-command'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('changing the system makes a new session and a PowerShell command with the Windows steps', async () => {
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByTestId('add-workstation-button'));
    await screen.findByTestId('install-command');
    await user.click(screen.getByTestId('os-windows'));
    await waitFor(() =>
      expect(screen.getByTestId('install-command')).toHaveTextContent(
        "irm 'https://hq.test/install/tok123/install.ps1' | iex",
      ),
    );
    expect(created.map((c) => c.os)).toEqual(['linux', 'windows']);
    const steps = screen.getByTestId('install-steps');
    expect(within(steps).getByText(/Ubuntu name and password/)).toBeInTheDocument();
    expect(within(steps).getByText(/PowerShell/)).toBeInTheDocument();
    expect(screen.queryByTestId('linux-flavours')).toBeNull();
  });

  it('follows the install: paired, doctor checks streaming in, then done', async () => {
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByTestId('add-workstation-empty'));
    await screen.findByTestId('install-command');

    status = {
      ...baseStatus('running'),
      steps: [{ step: 'installer', status: 'start', detail: 'linux', at: '2026-10-07T08:31:00.000Z' }],
    };
    await waitFor(
      () => expect(screen.getByTestId('install-progress')).toHaveAttribute('data-state', 'running'),
      { timeout: 5000 },
    );

    status = { ...baseStatus('paired'), workstationId: ID(5), workstationName: 'Desk' };
    await waitFor(() => expect(screen.getByTestId('stage-paired')).toHaveAttribute('data-done', 'true'), {
      timeout: 5000,
    });
    expect(screen.getByTestId('stage-paired')).toHaveTextContent('Paired as Desk');

    status = {
      ...baseStatus('checking'),
      workstationId: ID(5),
      workstationName: 'Desk',
      doctor: [
        { step: 'node', status: 'ok', detail: 'v22.23.2', at: '2026-10-07T08:32:00.000Z' },
        { step: 'docker', status: 'warn', detail: 'not found (optional)', at: '2026-10-07T08:32:01.000Z' },
      ],
    };
    const checks = await screen.findByTestId('doctor-checks', {}, { timeout: 5000 });
    expect(within(checks).getByTestId('doctor-node')).toHaveTextContent('v22.23.2');
    expect(within(checks).getByTestId('doctor-docker')).toHaveTextContent('warn');

    status = { ...status, state: 'done', result: 'success' };
    expect(await screen.findByTestId('install-success', {}, { timeout: 5000 })).toHaveTextContent(
      'Desk is connected',
    );
    expect(screen.getByTestId('stage-done')).toHaveAttribute('data-done', 'true');
    expect(screen.getByTestId('stage-checks')).toHaveAttribute('data-done', 'true');
  });

  it('a failed install links to help and Contact us', async () => {
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByTestId('add-workstation-empty'));
    await screen.findByTestId('install-command');
    status = {
      ...baseStatus('done'),
      result: 'failed',
      steps: [
        {
          step: 'Downloading the runner',
          status: 'fail',
          detail: 'Could not download the runner',
          at: '2026-10-07T08:31:00.000Z',
        },
      ],
    };
    const box = await screen.findByTestId('install-failure', {}, { timeout: 5000 });
    expect(box).toHaveTextContent('Could not download the runner');
    expect(within(box).getByTestId('install-help')).toHaveAttribute('href', '/help/install-troubleshooting');
    // the open-source app has no Contact us form; the hosted build adds one (and its tests check the link)
    expect(within(box).queryByTestId('install-contact')).toBeNull();
  });

  it('an expired command asks for a new one', async () => {
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByTestId('add-workstation-empty'));
    await screen.findByTestId('install-command');
    status = baseStatus('expired');
    expect(await screen.findByTestId('install-failure', {}, { timeout: 5000 })).toHaveTextContent('expired');
  });

  it('warns when the server has no runner release', async () => {
    const user = userEvent.setup();
    const orig = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/workstations/installers' && init?.method === 'POST')
          return json({ ...session('linux'), release: null }, 201);
        return orig(url, init);
      }),
    );
    wrap();
    await user.click(await screen.findByTestId('add-workstation-empty'));
    expect(await screen.findByTestId('no-release')).toBeInTheDocument();
  });

  it('keeps the manual pairing code path', async () => {
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByTestId('add-workstation-empty'));
    await user.click(await screen.findByTestId('pair-with-code'));
    expect(await screen.findByRole('button', { name: 'Generate pairing code' })).toBeInTheDocument();
  });
});

describe('installer guide data', () => {
  it('detects the system from the browser', () => {
    expect(detectOs({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' })).toBe(
      'windows',
    );
    expect(
      detectOs({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel' }),
    ).toBe('macos');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64)', platform: 'Linux x86_64' })).toBe(
      'linux',
    );
    expect(detectOs({ userAgent: 'x', platform: 'x', userAgentData: { platform: 'macOS' } })).toBe('macos');
  });

  it('has the command step for every system and says what it changes', () => {
    for (const os of ['windows', 'linux', 'macos'] as const) {
      expect(guideSteps(os).filter((s) => s.command)).toHaveLength(1);
      expect(whatItDoes(os).length).toBeGreaterThan(4);
    }
    expect(whatItDoes('windows').join(' ')).toMatch(/Guildwise HQ runner/);
    expect(whatItDoes('macos').join(' ')).toMatch(/launchd/);
    expect(whatItDoes('linux').join(' ')).toMatch(/systemd/);
  });
});
