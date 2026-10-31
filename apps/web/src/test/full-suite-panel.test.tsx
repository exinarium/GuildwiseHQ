import type { ProjectDetailResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FullSuitePanel } from '../components/FullSuitePanel.tsx';

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
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

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function renderPanel(
  p: Project,
  canChange = true,
  repos?: Array<{ id: string; name: string; workingBranch: string | null }>,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FullSuitePanel projectId={PROJECT} project={p} canChange={canChange} {...(repos ? { repos } : {})} />
    </QueryClientProvider>,
  );
}

describe('full suite panel (project settings)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is on by default with a plain-language label', () => {
    renderPanel(project());
    expect(screen.getByTestId('full-suite-state')).toHaveTextContent('On');
    expect(
      screen.getByRole('checkbox', {
        name: 'Run the full end-to-end test suite after each finished card',
      }),
    ).toBeChecked();
  });

  it('unticking calls the endpoint with enabled=false', async () => {
    const user = userEvent.setup();
    renderPanel(project());
    await user.click(screen.getByTestId('full-suite-toggle'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT}/full-suite`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  it('shows Off and is read-only for people who cannot change it', () => {
    renderPanel(project({ fullSuiteAfterFinalize: false, myRole: 'manager' }), false);
    expect(screen.getByTestId('full-suite-state')).toHaveTextContent('Off');
    expect(screen.getByTestId('full-suite-toggle')).toBeDisabled();
    expect(screen.getByTestId('full-suite-readonly')).toBeInTheDocument();
  });

  const TWO = [
    { id: '0192f3a0-0000-7000-8000-0000000000c1', name: 'cloud', workingBranch: 'release/1.4.0' },
    { id: '0192f3a0-0000-7000-8000-0000000000c2', name: 'core', workingBranch: 'main' },
  ];

  it('one repository: no picker, the run sends no repository', async () => {
    const user = userEvent.setup();
    renderPanel(project(), true, [TWO[0] as (typeof TWO)[number]]);
    expect(screen.queryByTestId('full-suite-repo')).toBeNull();
    await user.click(screen.getByTestId('full-suite-run'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT}/full-suite`);
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it('several repositories: a picker with name and working branch, and the choice is sent', async () => {
    const user = userEvent.setup();
    renderPanel(project(), true, TWO);
    const pick = screen.getByTestId('full-suite-repo');
    expect(screen.getByRole('option', { name: 'core (main)' })).toBeInTheDocument();
    await user.selectOptions(pick, TWO[1]?.id as string);
    await user.click(screen.getByTestId('full-suite-run'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ repoId: TWO[1]?.id });
  });

  it('several repositories: without touching the picker the first one is sent', async () => {
    const user = userEvent.setup();
    renderPanel(project(), true, TWO);
    await user.click(screen.getByTestId('full-suite-run'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ repoId: TWO[0]?.id });
  });
});
