import type { ProjectDetailResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectPolicyPanel } from '../components/ProjectPolicyPanel.tsx';

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

function renderPanel(p: Project, canChange = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProjectPolicyPanel projectId={PROJECT} project={p} canChange={canChange} />
    </QueryClientProvider>,
  );
}

describe('testing and decisions panel (project settings)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('both settings are off by default', () => {
    renderPanel(project());
    expect(screen.getByTestId('test-without-env-state')).toHaveTextContent('No');
    expect(screen.getByTestId('test-without-env-toggle')).not.toBeChecked();
    expect(screen.getByTestId('decisions-project-only-toggle')).not.toBeChecked();
  });

  it('ticking test without an environment sends only that setting', async () => {
    const user = userEvent.setup();
    renderPanel(project());
    await user.click(screen.getByTestId('test-without-env-toggle'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT}/policy`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ testWithoutEnvironment: true });
  });

  it('keeping decisions at project level sends that setting', async () => {
    const user = userEvent.setup();
    renderPanel(project());
    await user.click(screen.getByTestId('decisions-project-only-toggle'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ decisionsProjectOnly: true });
  });

  it('shows the saved values and is read-only for people who cannot change them', () => {
    renderPanel(project({ testWithoutEnvironment: true, decisionsProjectOnly: true }), false);
    expect(screen.getByTestId('test-without-env-state')).toHaveTextContent('Yes');
    expect(screen.getByTestId('test-without-env-toggle')).toBeDisabled();
    expect(screen.getByTestId('decisions-project-only-toggle')).toBeChecked();
    expect(screen.getByTestId('policy-readonly')).toBeInTheDocument();
  });
});
