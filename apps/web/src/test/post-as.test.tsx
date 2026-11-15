import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitAsPanel } from '../components/CommitAsPanel.tsx';
import { ToastProvider } from '../components/ui.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = ID(1);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const appOpt = (n: number, label: string, state = 'connected') => ({
  integrationId: ID(n),
  provider: 'github-app',
  label,
  botName: `${label.toLowerCase().replace(/ /g, '-')}[bot]`,
  botEmail: `${n}+bot@users.noreply.github.com`,
  instance: `${n}:1`,
  host: 'github.com',
  state,
});
const A = appOpt(50, 'Acme bot');
const B = appOpt(51, 'Other bot');
const OFF = appOpt(52, 'Offline bot', 'not_connected');

const repoRow = (n: number, name: string, resolved: Record<string, unknown>, access: unknown = null) => ({
  repoId: ID(n),
  repoName: name,
  forge: 'github',
  resolved: { repoId: ID(n), remoteUrlNormalized: `github.com/acme/${name}`, ...resolved },
  access,
});

const calls: Array<{ method: string; url: string; body?: any }> = [];
let state: Record<string, unknown>;
const base = (over: Record<string, unknown> = {}) => ({
  commitAs: null,
  clones: [],
  postAs: { selected: [], available: [A, B, OFF], canSelect: true, lastChange: null },
  repos: [repoRow(10, 'web', { source: 'repo' })],
  ...over,
});
beforeEach(() => {
  calls.length = 0;
  state = base();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init.method ?? 'GET', url, body });
      return json(state);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>{el}</ToastProvider>
    </QueryClientProvider>,
  );

describe('Post as app (project settings)', () => {
  it('an org manager ticks a connected app and saves it', async () => {
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Acme bot/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save apps' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/post-as'))).toBe(true),
    );
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      apps: [{ integrationId: A.integrationId }],
    });
  });

  it('a not connected app cannot be ticked and says where to connect it', async () => {
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    expect(await screen.findByRole('checkbox', { name: /Offline bot/ })).toBeDisabled();
    expect(screen.getByText(/Connect it on the Apps tab of Organization settings first/)).toBeInTheDocument();
  });

  it('a second app of the same provider is blocked with the server message', async () => {
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Acme bot/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Other bot/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A project can post as one GitHub App only; untick Acme bot first',
    );
    expect(screen.getByRole('button', { name: 'Save apps' })).toBeDisabled();
  });

  it('a non-manager sees the apps but cannot tick', async () => {
    state = base({ postAs: { selected: [], available: [A], canSelect: false, lastChange: null } });
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    expect(await screen.findByRole('checkbox', { name: /Acme bot/ })).toBeDisabled();
    expect(screen.getByText('Only an organization Owner or Admin can choose the app.')).toBeInTheDocument();
  });

  it('shows per repository the identity and credential, and warns for an uncovered or unchecked one', async () => {
    state = base({
      commitAs: { name: 'Pieter', email: 'p@example.test' },
      postAs: {
        selected: [A],
        available: [A, B],
        canSelect: true,
        lastChange: { by: 'Pieter', at: '2026-11-15T05:00:00.000Z' },
      },
      repos: [
        repoRow(
          10,
          'web',
          { source: 'app', app: { ...A, state: undefined } },
          { state: 'covered', checkedAt: '2026-11-15T05:00:00.000Z' },
        ),
        repoRow(
          11,
          'api',
          { source: 'project', fallbackReason: 'not_covered' },
          { state: 'not_covered', checkedAt: '2026-11-15T05:00:00.000Z' },
        ),
        repoRow(12, 'docs', { source: 'app', app: { ...A, state: undefined } }),
      ],
    });
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    const list = await screen.findByTestId('post-as-repos');
    expect(list).toHaveTextContent('web: Commits are made as acme-bot[bot]');
    // Until shifts push with the app's token, the credential stated is the one used today: the workstation's login.
    expect(list).toHaveTextContent(
      "web: Commits are made as acme-bot[bot] <50+bot@users.noreply.github.com> (GitHub App Acme bot). Pushed with the workstation's GitHub login. Pull requests and comments also use that login for now.",
    );
    expect(list).not.toHaveTextContent('installation token');
    expect(list).toHaveTextContent('api: Commits are made as Pieter <p@example.test>');
    expect(list).toHaveTextContent("Pushed with the workstation's GitHub login");
    expect(list).toHaveTextContent('Acme bot cannot reach this repository; it uses the fallback above.');
    expect(list).toHaveTextContent(
      'Access not checked yet; shifts stop if the app cannot reach this repository.',
    );
    expect(screen.getByText(/Last changed by Pieter/)).toBeInTheDocument();
  });

  it('a removed app shows "App removed, using fallback" and can be unticked', async () => {
    const gone = { ...A, state: 'removed' };
    state = base({
      postAs: { selected: [gone], available: [B], canSelect: true, lastChange: null },
      repos: [repoRow(10, 'web', { source: 'repo', fallbackReason: 'app_removed' })],
    });
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    const box = await screen.findByRole('checkbox', { name: /Acme bot/ });
    expect(box).toBeChecked();
    expect(screen.getAllByText(/App removed, using fallback/).length).toBeGreaterThanOrEqual(2);
    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: 'Save apps' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ apps: [] }));
  });

  it('says GitHub issue comments use the app and Jira keeps its own connection', async () => {
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    const line = await screen.findByTestId('post-as-trackers');
    expect(line.textContent).toMatch(/GitHub issues are posted as the selected GitHub App/);
    expect(line.textContent).toMatch(/Jira comments still use this workstation's Jira connection/);
  });

  it('without postAs from the server the panel renders as before', async () => {
    state = { commitAs: null, clones: [] };
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    await screen.findByTestId('commit-identities');
    expect(screen.queryByTestId('post-as')).toBeNull();
  });
});
