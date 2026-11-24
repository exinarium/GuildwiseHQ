import { BUILTIN_WORKFLOWS } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitAsPrompt } from '../components/CommitAsPrompt.tsx';
import { EmptyRepoBlock } from '../components/desk/EmptyRepoBlock.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { Projects } from '../pages/Projects.tsx';

// uat-runner-fixes-3 finding 6 (Commit as asked up front) and finding 5 (the one click for an empty repository).
const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ORG = ID(1);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const workflows = [...new Map(BUILTIN_WORKFLOWS.map((d) => [d.key, d])).values()].map((definition, n) => ({
  id: ID(200 + n),
  orgId: null,
  status: 'active',
  definition,
}));
const me = {
  user: { id: ORG, email: 'pieter@example.test', displayName: 'Pieter Jordaan', role: 'member' },
  isAdmin: false,
  orgs: [{ id: ORG, name: 'Acme', status: 'active', role: 'owner' }],
  activeOrg: { id: ORG, name: 'Acme', status: 'active', role: 'owner', mode: 'dev' },
  visibleProjectIds: [],
};

const calls: Array<{ method: string; url: string; body?: any }> = [];
let commitAs: unknown = null;
let clones: unknown[] = [];
beforeEach(() => {
  calls.length = 0;
  commitAs = null;
  clones = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init.method ?? 'GET', url, body });
      if (url === '/api/auth/me') return json(me);
      if (url.endsWith('/commit-as')) {
        if (init.method === 'PUT') commitAs = body.commitAs;
        return json({ commitAs, clones });
      }
      if (init.method === 'POST' && url === '/api/projects') return json({ project: { id: ID(9) } }, 201);
      if (init.method === 'POST') return json({ queued: true });
      if (url.startsWith('/api/projects')) return json({ projects: [] });
      if (url.includes('invitations')) return json({ invitations: [] });
      if (url.startsWith('/api/workflows')) return json({ workflows });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
    >
      <ToastProvider>
        <MemoryRouter>{el}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('New project asks "Commit as" up front', () => {
  it('a code project shows Commit as prefilled with the account and sends it', async () => {
    const user = userEvent.setup();
    wrap(<Projects />);
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    const form = await screen.findByRole('form', { name: 'New project' });
    await waitFor(() => expect(within(form).getAllByRole('radio').length).toBeGreaterThan(1));
    const box = within(form).getByTestId('new-project-commit-as');
    await waitFor(() => expect(within(box).getByLabelText('Name')).toHaveValue('Pieter Jordaan'));
    expect(within(box).getByLabelText('E-mail')).toHaveValue('pieter@example.test');
    await user.type(within(form).getAllByLabelText('Name')[0] as HTMLElement, 'Shop');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/projects')).toBe(true),
    );
    const sent = calls.find((c) => c.method === 'POST' && c.url === '/api/projects');
    expect(sent?.body).toMatchObject({
      name: 'Shop',
      commitAs: { name: 'Pieter Jordaan', email: 'pieter@example.test' },
    });
  });

  it('an e-mail that is not one stops the form with the reason', async () => {
    const user = userEvent.setup();
    wrap(<Projects />);
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    const form = await screen.findByRole('form', { name: 'New project' });
    const box = await within(form).findByTestId('new-project-commit-as');
    await waitFor(() => expect(within(box).getByLabelText('E-mail')).toHaveValue('pieter@example.test'));
    await user.clear(within(box).getByLabelText('E-mail'));
    await user.type(within(box).getByLabelText('E-mail'), 'nope');
    await user.type(within(form).getAllByLabelText('Name')[0] as HTMLElement, 'Shop');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    expect(await within(form).findByText(/Commit as:/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/projects')).toBe(false);
  });
});

describe('the first card of a project without a commit identity', () => {
  it('asks for Commit as (prefilled) and saves it', async () => {
    const user = userEvent.setup();
    wrap(<CommitAsPrompt projectId={ID(5)} canEdit />);
    const prompt = await screen.findByTestId('commit-as-prompt');
    await waitFor(() => expect(within(prompt).getByLabelText('Name')).toHaveValue('Pieter Jordaan'));
    await user.click(within(prompt).getByTestId('commit-as-prompt-save'));
    await waitFor(() => expect(screen.queryByTestId('commit-as-prompt')).toBeNull());
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      commitAs: { name: 'Pieter Jordaan', email: 'pieter@example.test' },
    });
  });

  it('says nothing when every clone has a git identity', async () => {
    clones = [
      {
        repoId: ID(10),
        repoName: 'web',
        workstationId: ID(20),
        workstationName: 'Desk',
        identity: { name: 'P', email: 'p@example.test', source: 'global' },
      },
    ];
    wrap(<CommitAsPrompt projectId={ID(5)} canEdit />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/commit-as'))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('commit-as-prompt')).toBeNull();
  });
});

describe('Desk: an empty repository', () => {
  it('one click asks the workstation for the first commit on the branch', async () => {
    const user = userEvent.setup();
    wrap(<EmptyRepoBlock data={{ projectId: ID(5), repoId: ID(6), workstationId: ID(7), branch: 'main' }} />);
    await user.click(screen.getByRole('button', { name: 'Create the first commit on main' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toEqual({
        method: 'POST',
        url: `/api/projects/${ID(5)}/repos/${ID(6)}/initial-commit`,
        body: { workstationId: ID(7) },
      }),
    );
    expect(
      await screen.findByText(/This item closes when the commit is on the repository/),
    ).toBeInTheDocument();
  });
});
