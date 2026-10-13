import { COMPLETION_ACTION_LABELS, CompletionAction } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkingBranchControl } from '../components/WorkingBranchControl.tsx';

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
      return json({}, init.method === 'POST' ? 202 : 200);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  remoteUrl: 'https://github.com/acme/shop.git',
  remoteUrlNormalized: 'github.com/acme/shop',
  workingBranch: 'develop',
  removedAt: null,
  mainBranch: null,
  knownBranches: ['develop', 'main'],
  ...over,
});

describe('the main branch and the working branch of a repository', () => {
  it('names both branches and says in one sentence each what they are for', async () => {
    wrap(<WorkingBranchControl projectId={ID(2)} repo={repoDto() as never} isOwner />);
    const main = await screen.findByTestId('main-branch-shop');
    expect(within(main).getByText('Main branch')).toBeInTheDocument();
    expect(main).toHaveTextContent('repository default');
    expect(main).toHaveTextContent('Where pull requests go.');
    const working = screen.getByTestId('working-branch-shop');
    expect(within(working).getByText('Working branch')).toBeInTheDocument();
    expect(working).toHaveTextContent('develop');
    expect(working).toHaveTextContent('Where finished card work is combined.');
    expect(working).toHaveTextContent('created from the main branch');
  });

  it('the owner names the main branch; an empty value goes back to the default branch', async () => {
    const user = userEvent.setup();
    wrap(<WorkingBranchControl projectId={ID(2)} repo={repoDto() as never} isOwner />);
    await user.click(await screen.findByRole('button', { name: 'Change main branch of shop' }));
    await user.type(screen.getByLabelText('Branch name'), 'release');
    await user.click(screen.getByRole('button', { name: 'Save main branch' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
        url: `/api/projects/${ID(2)}/repos/${ID(50)}`,
        body: { mainBranch: 'release' },
      }),
    );
  });

  it('a non-owner can see the branches but change nothing', async () => {
    wrap(
      <WorkingBranchControl
        projectId={ID(2)}
        repo={repoDto({ mainBranch: 'main' }) as never}
        isOwner={false}
      />,
    );
    expect(await screen.findByTestId('main-branch-shop')).toHaveTextContent('main');
    expect(screen.queryByRole('button', { name: /Change|Open pull request/ })).toBeNull();
  });

  it('says when the working branch will be created, and when it was', async () => {
    const first = wrap(
      <WorkingBranchControl
        projectId={ID(2)}
        repo={
          repoDto({
            workingBranch: 'next',
            mainBranch: 'main',
            knownBranchesAt: '2026-10-12T08:00:00.000Z',
          }) as never
        }
        isOwner
      />,
    );
    expect(await screen.findByTestId('working-branch-missing-shop')).toHaveTextContent(
      'has not been seen in the repository yet',
    );
    first.unmount();
    // a branch list of unknown age proves nothing: no claim at all
    const undated = wrap(
      <WorkingBranchControl
        projectId={ID(2)}
        repo={repoDto({ workingBranch: 'next', mainBranch: 'main' }) as never}
        isOwner
      />,
    );
    await screen.findByTestId('main-branch-shop');
    expect(screen.queryByTestId('working-branch-missing-shop')).toBeNull();
    undated.unmount();
    wrap(
      <WorkingBranchControl
        projectId={ID(2)}
        repo={
          repoDto({
            workingBranch: 'next',
            knownBranches: ['main', 'next'],
            workingBranchCreated: { at: '2026-10-12T08:00:00.000Z', from: 'main', pushed: true },
          }) as never
        }
        isOwner
      />,
    );
    expect(await screen.findByTestId('working-branch-created-shop')).toHaveTextContent(
      'created from main and pushed',
    );
  });

  it('warns when the main branch is not set, and not when it is', async () => {
    const first = wrap(<WorkingBranchControl projectId={ID(2)} repo={repoDto() as never} isOwner />);
    expect(await screen.findByRole('note')).toHaveTextContent('Main branch not set: the runner uses the host');
    first.unmount();
    wrap(<WorkingBranchControl projectId={ID(2)} repo={repoDto({ mainBranch: 'main' }) as never} isOwner />);
    await screen.findByTestId('main-branch-shop');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('opens a pull request from the working branch to the main branch (owner only, only when they differ)', async () => {
    const user = userEvent.setup();
    wrap(<WorkingBranchControl projectId={ID(2)} repo={repoDto({ mainBranch: 'main' }) as never} isOwner />);
    await user.click(await screen.findByRole('button', { name: 'Open pull request: develop to main' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        url: `/api/projects/${ID(2)}/repos/${ID(50)}/release-pr`,
      }),
    );
  });

  it('shows the answer of the last request, and no button when both branches are the same', async () => {
    const first = wrap(
      <WorkingBranchControl
        projectId={ID(2)}
        repo={
          repoDto({
            mainBranch: 'main',
            releasePr: {
              state: 'opened',
              url: 'https://github.com/acme/shop/pull/4',
              message: null,
              at: '2026-10-12T08:00:00.000Z',
            },
          }) as never
        }
        isOwner
      />,
    );
    expect(await screen.findByRole('link', { name: 'View the pull request' })).toHaveAttribute(
      'href',
      'https://github.com/acme/shop/pull/4',
    );
    first.unmount();
    wrap(
      <WorkingBranchControl projectId={ID(2)} repo={repoDto({ mainBranch: 'develop' }) as never} isOwner />,
    );
    await screen.findByTestId('main-branch-shop');
    expect(screen.queryByRole('button', { name: /Open pull request/ })).toBeNull();
  });
});

describe('completion actions are labelled by what they do', () => {
  it('"merge" is the commit-and-push option; the stored values do not change', () => {
    expect(CompletionAction.options).toEqual(['pr', 'push_branch', 'merge']);
    expect(COMPLETION_ACTION_LABELS.merge.label).toBe('Commit and push to the working branch');
    expect(COMPLETION_ACTION_LABELS.merge.description).toMatch(/No pull request/);
    expect(COMPLETION_ACTION_LABELS.pr.label).toBe('Pull request');
    expect(COMPLETION_ACTION_LABELS.push_branch.label).toBe('Push the card branch only');
  });
});
