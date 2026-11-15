import type { ProjectRepoDto } from '@aom/shared';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoPrOnlyControl } from '../components/RepoPrOnlyControl.tsx';

const ID = '0192f3a0-0000-7000-8000-0000000000';
const PROJECT = `${ID}02`;
const base = (over: Partial<ProjectRepoDto> = {}): ProjectRepoDto => ({
  id: `${ID}01`,
  projectId: PROJECT,
  name: 'app',
  remoteUrl: 'https://github.com/acme/app.git',
  remoteUrlNormalized: 'github.com/acme/app',
  workingBranch: null,
  removedAt: null,
  ...over,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The server side of the test: the stored repository, changed by PATCH and read back by GET. */
let stored: ProjectRepoDto;
const fetchMock = vi.fn();
beforeEach(() => {
  stored = base({ prOnly: false, prReview: null });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === `/api/projects/${PROJECT}` && (init?.method ?? 'GET') === 'GET')
      return json({ repos: [stored] });
    if (url === `/api/projects/${PROJECT}/repos/${stored.id}` && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      stored = {
        ...stored,
        prOnly: body.prOnly,
        prReview: body.prOnly ? { waiting: 0, checkedAt: null, problem: null } : null,
      };
      return json({ repos: [stored] });
    }
    return json({ error: { code: 'not_found', message: url } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/** The settings page in small: the control is fed from the project query the mutation invalidates. */
function Harness({ isOwner }: { isOwner: boolean }) {
  const q = useQuery({
    queryKey: ['project', PROJECT],
    queryFn: async () =>
      (await (await fetch(`/api/projects/${PROJECT}`)).json()) as { repos: ProjectRepoDto[] },
  });
  const repo = q.data?.repos[0];
  return repo ? <RepoPrOnlyControl projectId={PROJECT} repo={repo} isOwner={isOwner} /> : null;
}
const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe('PR-only review switch', () => {
  it('the owner turns it on: PATCH {prOnly:true} and the badge reads On after the refetch', async () => {
    wrap(<Harness isOwner />);
    const box = await screen.findByTestId('repo-pr-only-app');
    expect(screen.getByTestId('repo-pr-only-state-app')).toHaveTextContent('Off');
    expect(screen.getByLabelText(/PR-only review/)).toBe(box);
    fireEvent.click(box);
    await waitFor(() => expect(screen.getByTestId('repo-pr-only-state-app')).toHaveTextContent('On'));
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(JSON.parse(String((patchCall?.[1] as RequestInit | undefined)?.body ?? '{}'))).toEqual({
      prOnly: true,
    });
    expect(screen.getByTestId('repo-pr-only-app')).toBeChecked();
    expect(screen.getByTestId('repo-pr-only-status-app')).toHaveTextContent(
      '0 pull requests waiting for review.',
    );
  });

  it('the owner turns it off again: PATCH {prOnly:false} and the badge reads Off', async () => {
    stored = base({ prOnly: true, prReview: { waiting: 2, checkedAt: null, problem: null } });
    wrap(<Harness isOwner />);
    const box = await screen.findByTestId('repo-pr-only-app');
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(screen.getByTestId('repo-pr-only-state-app')).toHaveTextContent('Off'));
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(JSON.parse(String((patchCall?.[1] as RequestInit | undefined)?.body ?? '{}'))).toEqual({
      prOnly: false,
    });
  });

  it('is read-only for someone who is not the owner', async () => {
    wrap(<Harness isOwner={false} />);
    const box = await screen.findByTestId('repo-pr-only-app');
    expect(box).toBeDisabled();
    expect(screen.getByText('Only the project owner can change this.')).toBeInTheDocument();
  });

  it('shows why pull requests are not read, and has a touch-sized row with no text input', () => {
    wrap(
      <QueryClientProvider client={new QueryClient()}>
        <RepoPrOnlyControl
          projectId={PROJECT}
          isOwner
          repo={base({ prOnly: true, prReview: { waiting: 0, checkedAt: null, problem: 'unsupported' } })}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('repo-pr-only-status-app')).toHaveTextContent(
      'PR-only review is not available for this git host yet.',
    );
    const row = screen.getByTestId('repo-pr-only-app').closest('label');
    expect(row?.className).toContain('min-h-11');
    expect(document.querySelector('input[type="text"], textarea')).toBeNull();
  });
});
