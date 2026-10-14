import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitAsPanel } from '../components/CommitAsPanel.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { keysForEvent } from '../ws/invalidate.ts';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = ID(1);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const clone = (over: Record<string, unknown> = {}) => ({
  repoId: ID(10),
  repoName: 'web',
  workstationId: ID(20),
  workstationName: 'Desk',
  identity: { name: 'Pieter Jordaan', email: 'pieter@example.test', source: 'global' },
  ...over,
});

const calls: Array<{ method: string; url: string; body?: any }> = [];
let state: { commitAs: unknown; clones: unknown[] };
beforeEach(() => {
  calls.length = 0;
  state = { commitAs: null, clones: [clone()] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init.method ?? 'GET', url, body });
      if (init.method === 'PUT') state = { ...state, commitAs: body.commitAs };
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

describe('Commit as (project settings)', () => {
  it('shows the effective identity and where it comes from', async () => {
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    expect(await screen.findByTestId('commit-identities')).toHaveTextContent(
      "web on Desk: Commits are made as Pieter Jordaan <pieter@example.test> (from the workstation's global git config).",
    );
  });

  it('the project setting wins and is named as the source', async () => {
    state = { commitAs: { name: 'Acme Dev', email: 'dev@acme.test' }, clones: [clone()] };
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    expect(await screen.findByTestId('commit-identities')).toHaveTextContent(
      "Commits are made as Acme Dev <dev@acme.test> (from this project's Commit as setting).",
    );
    expect(screen.getByLabelText('Name')).toHaveValue('Acme Dev');
  });

  it('warns that nothing can be committed when a clone has no identity, naming the three places', async () => {
    state = { commitAs: null, clones: [clone({ identity: null })] };
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    const list = await screen.findByTestId('commit-identities');
    expect(list).toHaveTextContent('Nothing can be committed here yet');
    expect(list).toHaveTextContent('Project settings > Commit as');
    expect(list).toHaveTextContent('--global');
  });

  it('validates the e-mail before sending, then saves the setting', async () => {
    const user = userEvent.setup();
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    await screen.findByTestId('commit-identities');
    await user.type(screen.getByLabelText('Name'), 'Pieter Jordaan');
    await user.type(screen.getByLabelText('E-mail'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/e-mail/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await user.clear(screen.getByLabelText('E-mail'));
    await user.type(screen.getByLabelText('E-mail'), 'pieter@example.test');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      commitAs: { name: 'Pieter Jordaan', email: 'pieter@example.test' },
    });
    expect(await screen.findByText(/from this project's Commit as setting/)).toBeInTheDocument();
  });

  it('clearing both fields removes the setting', async () => {
    state = { commitAs: { name: 'Acme Dev', email: 'dev@acme.test' }, clones: [clone()] };
    const user = userEvent.setup();
    wrap(<CommitAsPanel projectId={PROJECT} canEdit />);
    await user.clear(await screen.findByLabelText('Name'));
    await user.clear(screen.getByLabelText('E-mail'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ commitAs: null }));
  });

  it('a viewer who may not edit sees the fields disabled and no Save button', async () => {
    wrap(<CommitAsPanel projectId={PROJECT} canEdit={false} />);
    await screen.findByTestId('commit-identities');
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('a project event refreshes it', () => {
    expect(
      keysForEvent({ type: 'ProjectCommitAsSet', streamId: `project-${PROJECT}`, projectId: PROJECT }),
    ).toContainEqual(['commit-as']);
  });
});
