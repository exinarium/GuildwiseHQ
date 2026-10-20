import type { ProjectClaudeAccountsView, ProjectDetailResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAccountPanel, emailMismatch } from '../components/ClaudeAccountPanel.tsx';
import { ClaudeAccountsTable } from '../components/workstations/ClaudeAccountsTable.tsx';

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const WS1 = '0192f3a0-0000-7000-8000-0000000000c1';
const WS2 = '0192f3a0-0000-7000-8000-0000000000c2';
type Project = ProjectDetailResponse['project'];
const project = (over: Partial<Project> = {}): Project => ({
  id: PROJECT,
  orgId: '0192f3a0-0000-7000-8000-0000000000a1',
  key: 'TOY',
  name: 'Toy',
  workflowKey: 'code',
  rank: 1,
  branchPrefix: 'aom/',
  workingBranch: 'main',
  subCategories: [],
  vaultFolder: null,
  architecturalGlobs: [],
  e2eGlobs: [],
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  myRole: 'owner',
  ...over,
});
const info = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  main: key === 'main',
  source: key === 'main' ? 'default' : 'config_dir',
  login: 'ok',
  usage: 'ok',
  ...over,
});
const ws = (over: Record<string, unknown> = {}): never =>
  ({
    workstationId: WS1,
    name: 'Desktop',
    connected: true,
    supportsAccounts: true,
    main: info('main'),
    ...over,
  }) as never;
const view = (over: Partial<ProjectClaudeAccountsView> = {}): ProjectClaudeAccountsView =>
  ({
    setting: { key: null, fallbackToMain: false },
    knownKeys: [],
    workstations: [],
    ...over,
  }) as ProjectClaudeAccountsView;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let current: ProjectClaudeAccountsView;
const fetchMock = vi.fn();
beforeEach(() => {
  current = view();
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (
      String(url).endsWith('/claude-accounts') &&
      (!init || init.method === undefined || init.method === 'GET')
    )
      return json(current);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderPanel(p: Project, canChange = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ClaudeAccountPanel projectId={PROJECT} project={p} canChange={canChange} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const puts = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');

describe('Claude account panel (project settings)', () => {
  it('defaults to the main account and the fallback box is unticked and disabled', () => {
    renderPanel(project());
    expect(screen.getByTestId('claude-account-state')).toHaveTextContent('Main account');
    expect(screen.getByTestId('claude-account-select')).toHaveValue('');
    const box = screen.getByTestId('claude-account-fallback');
    expect(box).not.toBeChecked();
    expect(box).toBeDisabled();
    expect(screen.getByTestId('claude-account-save')).toBeDisabled();
  });

  it('a new key is validated and saved with the fallback off by default', async () => {
    const user = userEvent.setup();
    renderPanel(project());
    await user.selectOptions(screen.getByTestId('claude-account-select'), 'New key…');
    const input = screen.getByTestId('claude-account-new');
    await user.type(input, 'Work Space');
    expect(await screen.findByRole('alert')).toHaveTextContent(/lowercase letters/);
    expect(screen.getByTestId('claude-account-save')).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'main');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'work');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('claude-account-fallback')).not.toBeChecked();
    await user.click(screen.getByTestId('claude-account-save'));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const [url, init] = puts()[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/' + PROJECT + '/claude-account');
    expect(JSON.parse(init.body as string)).toEqual({ accountKey: 'work', fallbackToMain: false });
  });

  it('ticking the fallback sends it; going back to the main account sends null', async () => {
    const user = userEvent.setup();
    current = view({ setting: { key: 'work', fallbackToMain: false }, knownKeys: ['work'] });
    renderPanel(project({ claudeAccount: { key: 'work', fallbackToMain: false } }));
    expect(screen.getByTestId('claude-account-select')).toHaveValue('work');
    await user.click(screen.getByTestId('claude-account-fallback'));
    await user.click(screen.getByTestId('claude-account-save'));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse((puts()[0] as [string, RequestInit])[1].body as string)).toEqual({
      accountKey: 'work',
      fallbackToMain: true,
    });
  });

  it('is read-only for somebody who cannot change it', () => {
    renderPanel(project(), false);
    expect(screen.getByTestId('claude-account-select')).toBeDisabled();
    expect(screen.getByTestId('claude-account-readonly')).toBeInTheDocument();
  });

  it('shows a status line per workstation: ready, limited, sign-in needed (with the link), provisioning, runner too old', async () => {
    current = view({
      setting: { key: 'work', fallbackToMain: false },
      knownKeys: ['work'],
      workstations: [
        ws({ account: info('work', { email: 'a@x.test', plan: 'claude_team' }) }),
        ws({
          workstationId: WS2,
          name: 'Laptop',
          account: info('work', {
            usage: 'limited',
            limitedUntil: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        }),
        ws({
          workstationId: '0192f3a0-0000-7000-8000-0000000000c3',
          name: 'Server',
          account: info('work', { login: 'none' }),
        }),
        ws({ workstationId: '0192f3a0-0000-7000-8000-0000000000c4', name: 'Cloud' }),
        ws({ workstationId: '0192f3a0-0000-7000-8000-0000000000c5', name: 'Old', supportsAccounts: false }),
        ws({
          workstationId: '0192f3a0-0000-7000-8000-0000000000c6',
          name: 'Locked',
          provisioning: 'needs_owner',
        }),
      ],
    });
    renderPanel(project({ claudeAccount: { key: 'work', fallbackToMain: false } }));
    const rows = await screen.findAllByTestId(/^claude-account-station-/);
    const text = (name: string) => rows.find((r) => r.textContent?.startsWith(name))?.textContent ?? '';
    expect(text('Desktop')).toMatch(/Ready \(a@x.test, claude_team\)/);
    expect(text('Laptop')).toMatch(/Limited until/);
    expect(text('Server')).toMatch(/Sign-in needed: the account has not been signed in yet/);
    expect(text('Cloud')).toMatch(/Provisioning/);
    expect(text('Old')).toMatch(/Runner too old: update it to 0.1.33/);
    expect(text('Locked')).toMatch(/aom-runner accounts add work/);

    const server = rows.find((r) => r.textContent?.startsWith('Server')) as HTMLElement;
    expect(within(server).getByTestId('claude-account-signin')).toHaveAttribute(
      'href',
      '/workstations/0192f3a0-0000-7000-8000-0000000000c3/integrations?focus=claude-code%3Awork&connect=1',
    );
  });

  it('warns when the same key is signed in as different people', () => {
    const v = view({
      workstations: [
        ws({ account: info('work', { email: 'a@x.test' }) }),
        ws({ workstationId: WS2, name: 'Laptop', account: info('work', { email: 'b@y.test' }) }),
      ],
    });
    expect(emailMismatch(v)).toBe('a@x.test on Desktop but b@y.test on Laptop');
    expect(
      emailMismatch(view({ workstations: [ws({ account: info('work', { email: 'a@x.test' }) })] })),
    ).toBeNull();
  });
});

describe('accounts table on the Workstations page', () => {
  const rt = (accounts: unknown[]) =>
    [{ id: 'claude-code', version: '2', available: true, capabilities: [], accounts }] as never;

  it('is hidden when only the main account exists', () => {
    const { container } = render(<ClaudeAccountsTable runtimes={rt([info('main')])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each account with its folder, person, login and usage', () => {
    render(
      <ClaudeAccountsTable
        runtimes={rt([
          info('main'),
          info('work', { configDir: '~/.claude-gw-work', email: 'a@x.test', plan: 'claude_team' }),
          info('other', { login: 'expired', usage: 'limited', limitedUntil: '2026-10-20T18:00:00.000Z' }),
        ])}
      />,
    );
    const work = screen.getByTestId('claude-account-row-work');
    expect(work).toHaveTextContent('~/.claude-gw-work');
    expect(work).toHaveTextContent('a@x.test (claude_team)');
    expect(work).toHaveTextContent('Signed in');
    expect(screen.getByTestId('claude-account-row-main')).toHaveTextContent('Main account');
    expect(screen.getByTestId('claude-account-row-other')).toHaveTextContent('Login expired');
    expect(screen.getByTestId('claude-account-row-other')).toHaveTextContent('Limited until');
  });
});
