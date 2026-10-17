import type { ProjectDetailResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FullSuitePanel } from '../components/FullSuitePanel.tsx';
import { OwnerApprovalPanel } from '../components/OwnerApprovalPanel.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const project = (over: Record<string, unknown> = {}) =>
  ({
    id: '0192f3a0-0000-7000-8000-0000000000b1',
    workflowKey: 'code-v6',
    ownerApprovalPolicy: 'large_or_high_risk',
    fullSuiteAfterFinalize: false,
    ...over,
  }) as unknown as ProjectDetailResponse['project'];

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('lean team project settings', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const last = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
  };

  it('asks for the owner approval of large and high-risk cards by default and can ask for every card', async () => {
    const user = userEvent.setup();
    wrap(<OwnerApprovalPanel projectId="p1" project={project()} canChange />);
    expect(screen.getByTestId('owner-approval-state')).toHaveTextContent('Large and high-risk cards');
    expect(screen.queryByTestId('upgrade-lean')).toBeNull();
    await user.click(screen.getByTestId('owner-approval-always'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(last()).toMatchObject({
      url: expect.stringContaining('/projects/p1/owner-approval'),
      method: 'PUT',
      body: { policy: 'always' },
    });
  });

  it('is read-only for a member who cannot change settings', () => {
    wrap(<OwnerApprovalPanel projectId="p1" project={project()} canChange={false} />);
    expect(screen.getByTestId('owner-approval-always')).toBeDisabled();
    expect(screen.getByTestId('owner-approval-readonly')).toBeInTheDocument();
  });

  it('offers the opt-in switch to a project on an older workflow and reports what stays behind', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      json({ workflowKey: 'code-v6', openCardsOnOlderVersion: 2, missingRoles: ['planner', 'pre_reviewer'] }),
    );
    wrap(<OwnerApprovalPanel projectId="p1" project={project({ workflowKey: 'code' })} canChange />);
    await user.click(screen.getByTestId('upgrade-lean-button'));
    await waitFor(() => expect(screen.getByTestId('upgrade-lean-result')).toBeInTheDocument());
    expect(last()).toMatchObject({
      url: expect.stringContaining('/projects/p1/upgrade-workflow'),
      method: 'POST',
    });
    expect(screen.getByTestId('upgrade-lean-result')).toHaveTextContent(
      '2 open card(s) stay on their version',
    );
    expect(screen.getByTestId('upgrade-lean-result')).toHaveTextContent('planner and a pre_reviewer');
  });

  it('the full suite has a button that starts it by hand', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(json({ cardId: 'c1', ref: 'TOY-9' }, 201));
    wrap(<FullSuitePanel projectId="p1" project={project()} canChange />);
    await user.click(screen.getByTestId('full-suite-run'));
    await waitFor(() => expect(screen.getByTestId('full-suite-started')).toHaveTextContent('Started TOY-9'));
    expect(last()).toMatchObject({ url: expect.stringContaining('/projects/p1/full-suite'), method: 'POST' });
  });
});
