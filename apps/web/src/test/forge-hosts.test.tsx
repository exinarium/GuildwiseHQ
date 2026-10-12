import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddRepoForm } from '../components/AddRepoForm.tsx';
import { RepoAccessControl } from '../components/RepoAccessControl.tsx';
import { RepoProjectPathControl } from '../components/RepoProjectPathControl.tsx';
import { RepoProviderControl } from '../components/RepoProviderControl.tsx';
import { Workstations } from '../pages/Workstations.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const AT = '2026-10-10T08:00:00.000Z';

const station = (git: unknown) => ({
  id: ID(10),
  userId: ID(1),
  name: 'Desk',
  platform: 'linux',
  hostname: 'desk.lan',
  runnerVersion: '1.0.0',
  status: 'active',
  connected: true,
  lastSeenAt: AT,
  runtimes: [],
  repos: [],
  pairedAt: AT,
  shifts: { running: 0, limit: 4 },
  git,
});

const connectedGithub = {
  connections: [
    {
      provider: 'github',
      host: 'github.com',
      state: 'connected',
      account: 'octo',
      method: 'cli',
      checkedAt: AT,
    },
    { provider: 'azure-devops', host: 'dev.azure.com', state: 'not_connected', detail: 'x', checkedAt: AT },
  ],
  checkedAt: AT,
};

const calls: Array<{ method: string; url: string; body?: unknown }> = [];
let gitState: unknown = connectedGithub;

beforeEach(() => {
  calls.length = 0;
  gitState = connectedGithub;
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url === '/api/auth/me')
        return json({
          user: {
            id: ID(1),
            email: 'me@example.test',
            displayName: 'Me',
            role: 'admin',
            status: 'active',
            createdAt: AT,
            lastLoginAt: null,
          },
          isAdmin: true,
          visibleProjectIds: [],
          features: { mockUi: false },
        });
      if (url === '/api/workstations') return json({ workstations: [station(gitState)] });
      if (method === 'POST' && url.endsWith('/git/recheck')) return json({ ok: true });
      if (method === 'POST' && url.endsWith('/git/ssh')) return json({ ok: true }, 202);
      if (method === 'POST' && url.endsWith('/git/repos'))
        return json(
          { requestId: ID(77), provider: body.provider, state: 'pending', repos: [], error: null },
          202,
        );
      if (url.includes('/git/repos/'))
        return json({
          requestId: ID(77),
          provider: 'github',
          state: 'done',
          repos: [
            {
              provider: 'github',
              fullName: 'acme/barcode-camera',
              cloneUrl: 'https://github.com/acme/barcode-camera.git',
              defaultBranch: 'develop',
              private: true,
            },
          ],
          error: null,
        });
      if (method === 'POST' && url.endsWith('/repos')) return json({}, 201);
      if (method === 'PATCH' && url.includes('/repos/')) return json({});
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement, opts: { expert?: boolean } = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Expert mode for code changes (track t2b) shows the branch field; simple mode hides it.
  if (opts.expert) qc.setQueryData(['me'], { user: { gitExpert: true } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  );
};

const repoDto = (over: Record<string, unknown> = {}) => ({
  id: ID(50),
  projectId: ID(2),
  name: 'shop',
  remoteUrl: 'https://dev.azure.com/acme/shop/_git/web',
  remoteUrlNormalized: 'dev.azure.com/acme/shop/_git/web',
  workingBranch: 'main',
  removedAt: null,
  forge: 'azure-devops',
  forgeOverride: null,
  ...over,
});

describe('Workstations page: git hosts', () => {
  it('shows connected / not connected per provider, with a Connect helper that never asks for a secret', async () => {
    const user = userEvent.setup();
    wrap(<Workstations />);
    await user.click(await screen.findByTestId('workstation-toggle'));
    const panel = await screen.findByTestId('git-connections');
    expect(within(panel).getByTestId('git-github')).toHaveTextContent('Connected as octo');
    expect(within(panel).getByTestId('git-azure-devops')).toHaveTextContent('Not connected');
    await user.click(
      within(within(panel).getByTestId('git-azure-devops')).getByRole('button', { name: 'Connect' }),
    );
    const helper = await screen.findByTestId('connect-azure-devops');
    expect(helper).toHaveTextContent('aom-runner git-connect azure-devops');
    expect(helper).toHaveTextContent('2026-12-01');
    expect(within(helper).queryByLabelText(/token|password/i)).toBeNull();
    await user.click(within(helper).getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/git/recheck'))).toBe(true),
    );
  });
});

describe('repository provider control', () => {
  it('shows the detected host and its connection; the owner can override it', async () => {
    const user = userEvent.setup();
    wrap(<RepoProviderControl projectId={ID(2)} repo={repoDto() as never} isOwner />);
    const row = await screen.findByTestId('repo-provider-shop');
    expect(row).toHaveTextContent('Azure DevOps');
    await screen.findByText('Not connected');
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.selectOptions(screen.getByLabelText('Git host of shop'), 'gitlab');
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
        url: `/api/projects/${ID(2)}/repos/${ID(50)}`,
        body: { forge: 'gitlab' },
      }),
    );
  });

  it('Bitbucket: a refused token and an unreachable host are told apart from "not connected", with the reason', async () => {
    const bb = (extra: Record<string, unknown>) => ({
      connections: [{ provider: 'bitbucket-cloud', host: 'bitbucket.org', checkedAt: AT, ...extra }],
      checkedAt: AT,
    });
    const repo = repoDto({ forge: 'bitbucket-cloud', remoteUrl: 'https://bitbucket.org/ws/shop.git' });
    gitState = bb({
      state: 'not_connected',
      problem: 'token_refused',
      detail: 'Bitbucket refused the saved token (HTTP 403: missing scope).',
    });
    const first = wrap(<RepoProviderControl projectId={ID(2)} repo={repo as never} isOwner />);
    await screen.findByText('Token refused');
    expect(screen.getByTestId('repo-provider-detail-shop')).toHaveTextContent('HTTP 403');
    first.unmount();

    gitState = bb({ state: 'unavailable', problem: 'unreachable', detail: 'Could not check the token.' });
    const second = wrap(<RepoProviderControl projectId={ID(2)} repo={repo as never} isOwner />);
    await screen.findByText('Could not check');
    second.unmount();

    gitState = bb({ state: 'connected', method: 'token', account: 'me@example.com' });
    wrap(<RepoProviderControl projectId={ID(2)} repo={repo as never} isOwner />);
    await screen.findByText('Connected as me@example.com');
    expect(screen.queryByTestId('repo-provider-detail-shop')).toBeNull();
  });

  it('plain git says no pull request is opened; a non-owner cannot change it', async () => {
    wrap(
      <RepoProviderControl
        projectId={ID(2)}
        repo={repoDto({ forge: 'git', remoteUrl: 'https://git.example.com/a/b.git' }) as never}
        isOwner={false}
      />,
    );
    expect(await screen.findByText(/no pull request is opened/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });
});

describe('Add repository form', () => {
  it('detects the provider from a pasted URL, and the override is sent when chosen', async () => {
    const user = userEvent.setup();
    wrap(<AddRepoForm projectId={ID(2)} />);
    await user.type(screen.getByLabelText('Remote URL'), 'git@ssh.dev.azure.com:v3/acme/shop/web');
    expect(await screen.findByText('Detected: Azure DevOps')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Repository name'), 'web');
    await user.click(screen.getByRole('button', { name: 'Add repository' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/repos'))).toBeTruthy(),
    );
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/repos'))?.body).toEqual({
      name: 'web',
      remoteUrl: 'git@ssh.dev.azure.com:v3/acme/shop/web',
    });

    calls.length = 0;
    await user.type(screen.getByLabelText('Remote URL'), 'https://code.corp.example/team/app.git');
    await user.selectOptions(screen.getByLabelText('Git host'), 'gitlab');
    await user.type(screen.getByLabelText('Repository name'), 'app');
    await user.click(screen.getByRole('button', { name: 'Add repository' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/repos'))).toBeTruthy());
    expect(calls.find((c) => c.url.endsWith('/repos'))?.body).toMatchObject({ forge: 'gitlab' });
  });

  it('create: no GitHub assumption, each provider asks for its own fields', async () => {
    const user = userEvent.setup();
    wrap(<AddRepoForm projectId={ID(2)} />);
    await user.click(screen.getByLabelText('Create a new repository'));
    // GitHub: Owner + Repository
    expect(screen.getByLabelText('Owner')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Git host'), 'azure-devops');
    expect(screen.getByLabelText('Organization')).toBeInTheDocument();
    expect(screen.getByLabelText('Project')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Organization'), 'acme');
    await user.type(screen.getByLabelText('Project'), 'Mobile');
    await user.type(screen.getByLabelText('Repository'), 'barcode-camera');
    await user.click(screen.getByRole('button', { name: 'Add repository' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/repos'))).toBeTruthy());
    expect(calls.find((c) => c.url.endsWith('/repos'))?.body).toMatchObject({
      name: 'barcode-camera',
      remoteUrl: 'https://dev.azure.com/acme/Mobile/_git/barcode-camera',
      forge: 'azure-devops',
      create: { name: 'acme/Mobile/barcode-camera', visibility: 'private' },
    });

    await user.selectOptions(screen.getByLabelText('Git host'), 'git');
    expect(screen.getByText(/plain git server has no API/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Owner')).toBeNull();
  });

  it('create validates the provider-specific name', async () => {
    const user = userEvent.setup();
    wrap(<AddRepoForm projectId={ID(2)} />);
    await user.click(screen.getByLabelText('Create a new repository'));
    await user.type(screen.getByLabelText('Owner'), 'acme');
    await user.type(screen.getByLabelText('Repository'), 'bad name!');
    await user.click(screen.getByRole('button', { name: 'Add repository' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/repository name may only contain/i);
    expect(calls.find((c) => c.url.endsWith('/repos'))).toBeUndefined();
  });

  it("lists the user's repositories from the connected provider and fills the form", async () => {
    const user = userEvent.setup();
    wrap(<AddRepoForm projectId={ID(2)} />, { expert: true });
    await user.click(await screen.findByRole('button', { name: 'Pick from my repositories' }));
    await user.click(screen.getByRole('button', { name: 'List repositories' }));
    const row = await screen.findByText('acme/barcode-camera');
    expect(calls.find((c) => c.url.endsWith('/git/repos'))?.body).toMatchObject({ provider: 'github' });
    await user.click(within(row.closest('li') as HTMLElement).getByRole('button', { name: 'Use' }));
    expect(screen.getByLabelText('Remote URL')).toHaveValue('https://github.com/acme/barcode-camera.git');
    expect(screen.getByLabelText('Repository name')).toHaveValue('barcode-camera');
    expect(screen.getByLabelText('Working branch (optional)')).toHaveValue('develop');
  });
});

describe('repository project path', () => {
  it('shows the repository root by default; the owner saves a sub directory and an invalid one is refused', async () => {
    const user = userEvent.setup();
    wrap(<RepoProjectPathControl projectId={ID(2)} repo={repoDto() as never} isOwner />);
    expect(await screen.findByTestId('repo-path-shop')).toHaveTextContent('repository root');
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const field = screen.getByLabelText('Project path in shop');
    await user.type(field, '../x');
    await user.click(screen.getByRole('button', { name: 'Save path' }));
    expect(await screen.findByText(/no "\.\."/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await user.clear(field);
    await user.type(field, 'src/app');
    await user.click(screen.getByRole('button', { name: 'Save path' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
        url: `/api/projects/${ID(2)}/repos/${ID(50)}`,
        body: { projectPath: 'src/app' },
      }),
    );
  });

  it('shows the saved path and gives a non-owner no way to change it', async () => {
    wrap(
      <RepoProjectPathControl
        projectId={ID(2)}
        repo={repoDto({ projectPath: 'web/client' }) as never}
        isOwner={false}
      />,
    );
    expect(await screen.findByTestId('repo-path-shop')).toHaveTextContent('web/client');
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });
});

describe('SSH instead of a token', () => {
  const sshState = (extra: Record<string, unknown> = {}) => ({
    connections: [
      {
        provider: 'bitbucket-cloud',
        host: 'bitbucket.org',
        state: 'not_connected',
        checkedAt: AT,
        ssh: {
          defaultMethod: 'ssh',
          key: 'generated',
          keyPath: '/home/u/.ssh/aom_bitbucket_cloud',
          publicKey: 'ssh-ed25519 AAAAC3 guildwise-bitbucket-cloud',
          ...extra,
        },
      },
    ],
    checkedAt: AT,
  });

  it('the Git hosts section shows the public key and where to add it, and asks the workstation to prepare and check', async () => {
    gitState = sshState({
      check: { state: 'not_authorized', detail: 'bitbucket.org refused the key.', checkedAt: AT },
    });
    const user = userEvent.setup();
    wrap(<Workstations />);
    await user.click(await screen.findByTestId('workstation-toggle'));
    const row = await screen.findByTestId('git-bitbucket-cloud');
    expect(row).toHaveTextContent('Default: SSH');
    await user.click(within(row).getByRole('button', { name: 'SSH' }));
    const panel = await screen.findByTestId('ssh-bitbucket-cloud');
    expect(within(panel).getByTestId('ssh-public-key-bitbucket-cloud')).toHaveTextContent(
      'ssh-ed25519 AAAAC3 guildwise-bitbucket-cloud',
    );
    expect(panel).toHaveTextContent('Personal settings, SSH keys');
    expect(within(panel).getByTestId('ssh-detail-bitbucket-cloud')).toHaveTextContent('refused the key');
    expect(panel).toHaveTextContent('aom-runner git-connect bitbucket-cloud --ssh');
    // The page never offers a field for the private key itself.
    expect(within(panel).queryByLabelText(/passphrase|private key content/i)).toBeNull();

    await user.click(within(panel).getByRole('button', { name: 'Save and create key' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/ssh'))?.body).toMatchObject({
        provider: 'bitbucket-cloud',
        action: 'prepare',
        defaultMethod: 'ssh',
        key: 'generated',
      }),
    );
    calls.length = 0;
    await user.type(
      within(panel).getByLabelText('Check against a repository (optional)'),
      'https://bitbucket.org/ws/repo.git',
    );
    await user.click(within(panel).getByRole('button', { name: 'Check SSH' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/git/ssh'))?.body).toMatchObject({
        action: 'check',
        repoUrl: 'https://bitbucket.org/ws/repo.git',
      }),
    );
  });

  it('a key file of your own is sent as a path', async () => {
    gitState = sshState();
    const user = userEvent.setup();
    wrap(<Workstations />);
    await user.click(await screen.findByTestId('workstation-toggle'));
    const row = await screen.findByTestId('git-bitbucket-cloud');
    await user.click(within(row).getByRole('button', { name: 'SSH' }));
    const panel = await screen.findByTestId('ssh-bitbucket-cloud');
    await user.selectOptions(within(panel).getByLabelText('SSH key of Bitbucket Cloud'), 'path');
    await user.type(
      within(panel).getByLabelText('Private key file on the workstation'),
      '/home/u/.ssh/id_ed25519',
    );
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/git/ssh'))?.body).toMatchObject({
        action: 'save',
        key: 'path',
        keyPath: '/home/u/.ssh/id_ed25519',
      }),
    );
  });

  it('a repository follows the workstation default, can be overridden by the owner, and says what SSH cannot do', async () => {
    gitState = sshState({ check: { state: 'ok', detail: 'ok', checkedAt: AT } });
    const user = userEvent.setup();
    const repo = repoDto({ forge: 'bitbucket-cloud', remoteUrl: 'https://bitbucket.org/ws/shop.git' });
    wrap(<RepoAccessControl projectId={ID(2)} repo={repo as never} isOwner />);
    const row = await screen.findByTestId('repo-access-shop');
    await waitFor(() => expect(row).toHaveTextContent('SSH key'));
    expect(row).toHaveTextContent('workstation default for bitbucket.org');
    expect(row).toHaveTextContent('SSH works');
    expect(await screen.findByTestId('repo-access-rest-shop')).toHaveTextContent(
      'the branch is pushed and the manager opens the pull request',
    );
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.selectOptions(screen.getByLabelText('Access method of shop'), 'https');
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
        url: `/api/projects/${ID(2)}/repos/${ID(50)}`,
        body: { accessMethod: 'https' },
      }),
    );
  });

  it('a non-owner cannot change it; an explicit https choice shows no SSH note', async () => {
    gitState = sshState();
    const repo = repoDto({
      forge: 'bitbucket-cloud',
      remoteUrl: 'https://bitbucket.org/ws/shop.git',
      accessMethod: 'https',
    });
    wrap(<RepoAccessControl projectId={ID(2)} repo={repo as never} isOwner={false} />);
    const row = await screen.findByTestId('repo-access-shop');
    expect(row).toHaveTextContent('API token / CLI login (https)');
    expect(row).toHaveTextContent('chosen by you');
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByTestId('repo-access-rest-shop')).toBeNull();
  });

  it('Add repository sends the chosen access method', async () => {
    const user = userEvent.setup();
    wrap(<AddRepoForm projectId={ID(2)} />);
    await user.type(screen.getByLabelText('Remote URL'), 'https://github.com/acme/web.git');
    await user.type(screen.getByLabelText('Repository name'), 'web');
    await user.selectOptions(screen.getByLabelText('Access'), 'ssh');
    await user.click(screen.getByRole('button', { name: 'Add repository' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/repos'))).toBeTruthy());
    expect(calls.find((c) => c.url.endsWith('/repos'))?.body).toMatchObject({ accessMethod: 'ssh' });
  });
});
