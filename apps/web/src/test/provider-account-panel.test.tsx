import type { ProjectDetailResponse, ProjectProviderAccountsView } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { choiceLabel, ProviderAccountPanel, stationStatus } from '../components/ProviderAccountPanel.tsx';
import { UsageLimitBanner } from '../components/UsageLimitBanner.tsx';
import { DeskItem } from '../pages/Desk.tsx';

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const WS = '0192f3a0-0000-7000-8000-0000000000c1';
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
const status = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  main: key === 'main',
  kind: 'login',
  login: 'ok',
  usage: 'ok',
  ...over,
});
const view = (scope: string, over: Partial<ProjectProviderAccountsView> = {}): ProjectProviderAccountsView =>
  ({
    scope,
    label: scope,
    kind: scope === 'codex' || scope === 'gemini' ? 'login' : 'key',
    setting: { key: null, fallbackToMain: false },
    knownKeys: [],
    orgKey: false,
    workstations: [],
    ...over,
  }) as ProjectProviderAccountsView;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
let views: Record<string, ProjectProviderAccountsView>;
const fetchMock = vi.fn();
beforeEach(() => {
  views = {};
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const m = /\/provider-accounts\/([a-z-]+)$/.exec(String(url));
    if (m && (!init?.method || init.method === 'GET'))
      return json(views[m[1] as string] ?? view(m[1] as string));
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
        <ProviderAccountPanel projectId={PROJECT} project={p} canChange={canChange} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const puts = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT') as Array<
    [string, RequestInit]
  >;

describe('project settings: accounts for other providers', () => {
  it('lists Codex, the Gemini CLI and each provider with the project’s choice (main by default); Claude Code has its own panel', () => {
    renderPanel(
      project({
        providerAccounts: {
          openai: { key: 'org', fallbackToMain: false },
          codex: { key: 'work', fallbackToMain: true },
        },
      }),
    );
    for (const id of [
      'codex',
      'gemini',
      'anthropic',
      'openai',
      'google',
      'openai-compatible',
      'bedrock',
      'vertex',
      'gateway',
    ])
      expect(screen.getByTestId(`pa-row-${id}`)).toBeInTheDocument();
    expect(screen.queryByTestId('pa-row-claude-code')).toBeNull();
    expect(screen.getByTestId('pa-state-gemini')).toHaveTextContent('Main account');
    expect(screen.getByTestId('pa-state-codex')).toHaveTextContent('work');
    expect(screen.getByTestId('pa-state-openai')).toHaveTextContent('Organization key');
    expect(screen.getByTestId('pa-row-codex')).toHaveTextContent('falls back to main');
  });

  it('picks a known account, saves it with the fallback off by default', async () => {
    const user = userEvent.setup();
    views.codex = view('codex', { knownKeys: ['team', 'work'] });
    renderPanel(project());
    await user.click(screen.getByTestId('pa-toggle-codex'));
    const select = await screen.findByTestId('pa-select-codex');
    await waitFor(() => expect(within(select).getByRole('option', { name: 'work' })).toBeInTheDocument());
    expect(screen.getByTestId('pa-fallback-codex')).toBeDisabled();
    await user.selectOptions(select, 'work');
    expect(screen.getByTestId('pa-fallback-codex')).not.toBeChecked();
    await user.click(screen.getByTestId('pa-save-codex'));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const [url, init] = puts()[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT}/provider-accounts/codex`);
    expect(JSON.parse(init.body as string)).toEqual({ accountKey: 'work', fallbackToMain: false });
  });

  it('a new name is validated (not main, not org) before it can be saved', async () => {
    const user = userEvent.setup();
    renderPanel(project());
    await user.click(screen.getByTestId('pa-toggle-gemini'));
    await user.selectOptions(await screen.findByTestId('pa-select-gemini'), 'New name…');
    const input = screen.getByTestId('pa-new-gemini');
    for (const bad of ['main', 'org', 'Work Space']) {
      await user.clear(input);
      await user.type(input, bad);
      expect(await screen.findByRole('alert')).toHaveTextContent(/lowercase letters/);
      expect(screen.getByTestId('pa-save-gemini')).toBeDisabled();
    }
    await user.clear(input);
    await user.type(input, 'personal');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByTestId('pa-fallback-gemini'));
    await user.click(screen.getByTestId('pa-save-gemini'));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse((puts()[0] as [string, RequestInit])[1].body as string)).toEqual({
      accountKey: 'personal',
      fallbackToMain: true,
    });
  });

  it('the organization’s key is offered for a provider key when the organization has one, with its cap noted', async () => {
    const user = userEvent.setup();
    views.openai = view('openai', { orgKey: true, knownKeys: ['work'] });
    renderPanel(project());
    await user.click(screen.getByTestId('pa-toggle-openai'));
    const select = await screen.findByTestId('pa-select-openai');
    await waitFor(() =>
      expect(
        within(select).getByRole('option', { name: /Organization key \(counts against its monthly cap\)/ }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(select, 'org');
    await user.click(screen.getByTestId('pa-save-openai'));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse((puts()[0] as [string, RequestInit])[1].body as string)).toEqual({
      accountKey: 'org',
      fallbackToMain: false,
    });
  });

  it('no organization key option for a login runtime or when the organization has none', async () => {
    const user = userEvent.setup();
    renderPanel(project());
    await user.click(screen.getByTestId('pa-toggle-codex'));
    expect(
      within(await screen.findByTestId('pa-select-codex')).queryByRole('option', {
        name: /Organization key/,
      }),
    ).toBeNull();
    await user.click(screen.getByTestId('pa-toggle-google'));
    expect(
      within(await screen.findByTestId('pa-select-google')).queryByRole('option', {
        name: /Organization key/,
      }),
    ).toBeNull();
  });

  it('going back to the main account sends null', async () => {
    const user = userEvent.setup();
    views.codex = view('codex', { setting: { key: 'work', fallbackToMain: true }, knownKeys: ['work'] });
    renderPanel(project({ providerAccounts: { codex: { key: 'work', fallbackToMain: true } } }));
    await user.click(screen.getByTestId('pa-toggle-codex'));
    await user.selectOptions(
      await screen.findByTestId('pa-select-codex'),
      'Main account (each workstation’s own)',
    );
    await user.click(screen.getByTestId('pa-save-codex'));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse((puts()[0] as [string, RequestInit])[1].body as string)).toEqual({
      accountKey: null,
      fallbackToMain: false,
    });
  });

  it('shows how the account stands on each workstation, with the way to fix it', async () => {
    const user = userEvent.setup();
    views.codex = view('codex', {
      setting: { key: 'work', fallbackToMain: false },
      knownKeys: ['work'],
      workstations: [
        {
          workstationId: WS,
          name: 'Desktop',
          connected: true,
          supportsAccounts: true,
          main: status('main') as never,
          account: status('work', { login: 'none' }) as never,
        },
      ],
    });
    renderPanel(project({ providerAccounts: { codex: { key: 'work', fallbackToMain: false } } }));
    await user.click(screen.getByTestId('pa-toggle-codex'));
    expect(await screen.findByTestId('pa-status-codex')).toHaveTextContent('Sign-in needed');
    expect(screen.getByTestId('pa-fix-codex')).toHaveAttribute(
      'href',
      expect.stringContaining(`/workstations/${WS}/integrations?focus=codex%3Awork&connect=1`),
    );
  });

  it('is read-only for somebody who cannot change it', async () => {
    const user = userEvent.setup();
    renderPanel(project(), false);
    await user.click(screen.getByTestId('pa-toggle-codex'));
    expect(await screen.findByTestId('pa-select-codex')).toBeDisabled();
    expect(screen.getByText(/Only the project Owner/)).toBeInTheDocument();
  });
});

describe('station status lines', () => {
  const login = { kind: 'login', setting: { key: 'work', fallbackToMain: false }, label: 'Codex' } as const;
  const keyV = { kind: 'key', setting: { key: 'work', fallbackToMain: false }, label: 'OpenAI' } as const;
  const w = (over: Record<string, unknown> = {}) =>
    ({ workstationId: WS, name: 'D', connected: true, supportsAccounts: true, ...over }) as never;
  it('ready, limited, sign-in needed, missing and too old', () => {
    expect(stationStatus(w({ account: status('work', { email: 'a@x.test' }) }), login)).toMatchObject({
      tone: 'ok',
      text: 'Ready (a@x.test).',
    });
    expect(
      stationStatus(
        w({ account: status('work', { usage: 'limited', limitedUntil: '2026-10-14T18:00:00.000Z' }) }),
        login,
      ),
    ).toMatchObject({ tone: 'warn' });
    expect(stationStatus(w({ account: status('work', { login: 'expired' }) }), login)).toMatchObject({
      tone: 'bad',
      fix: 'sign-in',
    });
    expect(stationStatus(w({}), login)).toMatchObject({
      tone: 'bad',
      fix: 'sign-in',
      text: expect.stringContaining('not set up'),
    });
    expect(stationStatus(w({}), keyV)).toMatchObject({ tone: 'bad', fix: 'key' });
    expect(
      stationStatus(
        w({
          account: status('work', {
            kind: 'key',
            login: 'none',
            detail: 'The account work has no key on this workstation.',
          }),
        }),
        keyV,
      ),
    ).toMatchObject({ fix: 'key' });
    expect(stationStatus(w({ supportsAccounts: false }), login)).toMatchObject({
      tone: 'bad',
      text: expect.stringContaining('Runner too old'),
    });
    expect(choiceLabel(null)).toBe('Main account');
    expect(choiceLabel('org')).toBe('Organization key');
  });
});

describe('the usage-limit banner for the other runtimes', () => {
  const limit = (over: Record<string, unknown>) => ({
    until: '2026-10-14T18:00:00.000Z',
    workstationName: 'Desktop',
    label: null,
    ...over,
  });
  it('names Codex or the Gemini CLI instead of Claude', () => {
    const { unmount } = render(
      <UsageLimitBanner limit={limit({ accountKey: 'work', mode: 'paused', scope: 'codex' }) as never} />,
    );
    expect(screen.getByTestId('usage-limit-banner')).toHaveTextContent(
      'The Codex account work behind this project hit its usage limit',
    );
    unmount();
    render(
      <UsageLimitBanner limit={limit({ accountKey: 'main', mode: 'paused', scope: 'gemini' }) as never} />,
    );
    expect(screen.getByTestId('usage-limit-banner')).toHaveTextContent(
      'The Gemini CLI subscription behind this project hit its usage limit',
    );
  });
  it('Claude is still Claude', () => {
    render(<UsageLimitBanner limit={limit({ accountKey: 'work', mode: 'paused' }) as never} />);
    expect(screen.getByTestId('usage-limit-banner')).toHaveTextContent('The Claude account work');
  });
});

describe('the desk notice for an account that needs a sign-in or a key', () => {
  it('links to the tile of that scope and account on the workstation', () => {
    const item = {
      id: '0192f3a0-0000-7000-8000-0000000000d1',
      kind: 'alert',
      subkind: 'provider_account_login',
      status: 'open',
      routedTo: 'manager',
      title: 'Codex account work needs a sign-in on Desktop',
      body: 'x',
      doing: '',
      options: [],
      recommendation: null,
      blocking: false,
      pinned: false,
      urgent: false,
      affectedCardIds: [],
      affectedCount: 0,
      askedBy: { kind: 'system', agentId: null, agentName: null, role: null },
      card: null,
      projectId: null,
      dedupEntries: [],
      answer: null,
      answerOption: null,
      answeredAt: null,
      answeredByName: null,
      decisionPolicy: null,
      canAnswer: true,
      createdAt: '2026-10-14T10:00:00.000Z',
      data: { key: `provider_account:${WS}:codex:work`, workstationId: WS },
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <DeskItem item={item as never} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('desk-sign-in-web')).toHaveAttribute(
      'href',
      `/workstations/${WS}/integrations?focus=codex%3Awork&connect=1`,
    );
  });
});
