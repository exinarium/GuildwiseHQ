import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoComponentRulesControl } from '../components/RepoComponentRulesControl.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const calls: Array<{ method: string; url: string; body?: unknown }> = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
};

const runner = {
  name: 'runner',
  paths: ['apps/runner/**'],
  versionFile: 'apps/runner/src/version.ts',
  pattern: "RUNNER_VERSION = '(.*)'",
};
const repoDto = (rules: unknown[] = []) => ({
  id: ID(50),
  projectId: ID(2),
  name: 'shop',
  remoteUrl: 'https://github.com/acme/shop.git',
  remoteUrlNormalized: 'github.com/acme/shop',
  workingBranch: 'main',
  removedAt: null,
  componentRules: rules,
});
const patches = () => calls.filter((c) => c.method === 'PATCH');

describe('component version rules editor', () => {
  it('shows none, or one line per rule', () => {
    const { unmount } = wrap(
      <RepoComponentRulesControl projectId={ID(2)} repo={repoDto() as never} isOwner />,
    );
    expect(screen.getByTestId('repo-rules-shop')).toHaveTextContent('none');
    unmount();
    wrap(<RepoComponentRulesControl projectId={ID(2)} repo={repoDto([runner]) as never} isOwner />);
    expect(screen.getByTestId('repo-rules-shop')).toHaveTextContent(
      'runner: apps/runner/** → apps/runner/src/version.ts',
    );
  });

  it('a non-owner cannot edit', () => {
    wrap(<RepoComponentRulesControl projectId={ID(2)} repo={repoDto([runner]) as never} isOwner={false} />);
    expect(screen.queryByRole('button', { name: /Edit component version rules/ })).toBeNull();
  });

  it('adds a rule and sends the full list', async () => {
    const user = userEvent.setup();
    wrap(<RepoComponentRulesControl projectId={ID(2)} repo={repoDto() as never} isOwner />);
    await user.click(screen.getByRole('button', { name: 'Edit component version rules of shop' }));
    expect(document.activeElement).toBe(document.body);
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await user.type(screen.getByLabelText('Name'), 'runner');
    await user.type(screen.getByLabelText('Path globs'), 'apps/runner/**');
    await user.type(screen.getByLabelText('Version file'), 'apps/runner/src/version.ts');
    await user.type(screen.getByLabelText('Pattern'), "RUNNER_VERSION = '(.*)'");
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toMatchObject({
      url: `/api/projects/${ID(2)}/repos/${ID(50)}`,
      body: { componentRules: [runner] },
    });
  });

  it('edits a rule', async () => {
    const user = userEvent.setup();
    wrap(<RepoComponentRulesControl projectId={ID(2)} repo={repoDto([runner]) as never} isOwner />);
    await user.click(screen.getByRole('button', { name: 'Edit component version rules of shop' }));
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'cli');
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]?.body).toEqual({ componentRules: [{ ...runner, name: 'cli' }] });
  });

  it('removing the last rule sends an empty list', async () => {
    const user = userEvent.setup();
    wrap(<RepoComponentRulesControl projectId={ID(2)} repo={repoDto([runner]) as never} isOwner />);
    await user.click(screen.getByRole('button', { name: 'Edit component version rules of shop' }));
    await user.click(screen.getByRole('button', { name: 'Remove rule runner' }));
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]?.body).toEqual({ componentRules: [] });
  });

  it('refuses a bad pattern in the browser, next to the field, without a request', async () => {
    const user = userEvent.setup();
    wrap(<RepoComponentRulesControl projectId={ID(2)} repo={repoDto([runner]) as never} isOwner />);
    await user.click(screen.getByRole('button', { name: 'Edit component version rules of shop' }));
    const pattern = screen.getByLabelText('Pattern');
    await user.clear(pattern);
    await user.type(pattern, 'RUNNER_VERSION = 1');
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    const form = screen.getByRole('form', { name: 'Component version rules of shop' });
    expect(within(form).getByText(/exactly one capture group/)).toBeInTheDocument();
    expect(patches()).toHaveLength(0);
  });

  it('Cancel discards the draft', async () => {
    const user = userEvent.setup();
    wrap(<RepoComponentRulesControl projectId={ID(2)} repo={repoDto([runner]) as never} isOwner />);
    await user.click(screen.getByRole('button', { name: 'Edit component version rules of shop' }));
    await user.click(screen.getByRole('button', { name: 'Remove rule runner' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('repo-rules-shop')).toHaveTextContent('runner:');
    expect(patches()).toHaveLength(0);
  });
});
