import type { CardDetailResponse } from '@aom/shared';
import { codeWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardDetailView } from '../pages/CardDetail.tsx';
import { CardNewForm } from '../pages/CardNew.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-10-13T10:00:00.000Z';

function newForm(repos: Array<{ id: string; name: string }>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(['me'], { user: { gitExpert: false } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CardNewForm
          projectId={ID(1)}
          projectKey="TOY"
          projectKeys={['TOY']}
          onProject={() => {}}
          workflow={codeWorkflowV1}
          repos={repos}
          mockUi={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup({ applyAccept: false });
}

describe('"Not sure: let the BA find out"', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          card: { id: ID(5), ref: 'TOY-5' },
          missing: ['repoId'],
          message: 'Saved as a draft: sent to the BA to find the repository and complete: repository.',
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const fill = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText('Title'), 'Reset link is broken');
    for (const label of ['Context', 'Requirements', 'Affected areas', 'Constraints', 'Test plan'])
      await user.type(screen.getByLabelText(label), `${label} text`);
    await user.type(screen.getByLabelText('Acceptance criteria'), 'it works');
  };

  it('is offered with two or more repositories and sends findRepo instead of a repository', async () => {
    const user = newForm([
      { id: ID(2), name: 'api' },
      { id: ID(3), name: 'web' },
    ]);
    const select = screen.getByLabelText('Repository') as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: 'Not sure: let the BA find out' })).toBeInTheDocument();
    await fill(user);
    await user.selectOptions(select, within(select).getByRole('option', { name: /Not sure/ }));
    await user.click(screen.getByRole('button', { name: 'Specify' }));
    // no "Repository is required" error: the BA finds it
    expect(screen.queryByText('Repository is required to specify this card')).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ specify: true, findRepo: true });
    expect(body).not.toHaveProperty('repoId');
  });

  it('is not offered with a single repository', () => {
    newForm([{ id: ID(2), name: 'api' }]);
    expect(screen.queryByRole('option', { name: /Not sure/ })).toBeNull();
  });
});

const detail = (over: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    card: {
      id: ID(10),
      ref: 'TOY-10',
      title: 'Reset link is broken',
      cardType: 'feature',
      stage: 'spec',
      status: 'cancelled',
      projectId: ID(2),
      number: 10,
      workflowKey: 'code',
      workflowVersion: 1,
      column: 'Spec',
      fields: {},
      ownerUserId: ID(1),
      decisionPolicy: 'owner_only',
      riskTierOverridden: false,
      docsNeeded: false,
      completionAction: null,
      repoId: null,
      baseBranch: 'main',
      branchName: null,
      homeWorkstationId: null,
      parentCardId: null,
      origin: 'manual',
      scheduled: false,
      claimedByAgentId: null,
      claimedByAgentName: null,
      claimedAt: null,
      blockedSince: null,
      dependencies: [],
      createdAt: NOW,
      updatedAt: NOW,
      queuedAt: null,
      finalizedAt: null,
      riskTier: null,
      assignee: null,
      blocked: false,
      reworkRound: 0,
      priority: 3,
      ...over,
    },
    handoffs: [],
    transitions: [],
    activity: [],
    threadId: ID(10),
    thread: [],
    currentShift: null,
    permissions: {
      canEdit: false,
      canSpecify: true,
      canMove: false,
      canRelease: false,
      canCancel: false,
      canComment: true,
      canSetRisk: false,
    },
    blockers: [],
    ...extra,
  }) as unknown as CardDetailResponse;

function view(d: CardDetailResponse) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CardDetailView data={d} workflow={codeWorkflowV1} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CardDetail: a card the BA split', () => {
  it('lists the cards it was split into, with their repositories, and links to them', () => {
    view(
      detail(
        {},
        {
          splitInto: [
            { id: ID(11), ref: 'TOY-11', title: 'API: issue the link', status: 'queued', repoName: 'api' },
            { id: ID(12), ref: 'TOY-12', title: 'Web: open the page', status: 'queued', repoName: 'web' },
          ],
        },
      ),
    );
    const links = screen.getByTestId('split-links');
    expect(within(links).getByText('Split into')).toBeInTheDocument();
    expect(within(links).getByRole('link', { name: 'TOY-11' })).toHaveAttribute('href', `/cards/${ID(11)}`);
    expect(within(links).getByTestId('split-into-TOY-12')).toHaveTextContent('Web: open the page (web)');
  });

  it('a child links back to the card it was split from', () => {
    view(detail({ status: 'queued', repoId: ID(3) }, { splitFrom: { id: ID(9), ref: 'TOY-9' } }));
    expect(within(screen.getByTestId('split-from')).getByRole('link', { name: 'TOY-9' })).toHaveAttribute(
      'href',
      `/cards/${ID(9)}`,
    );
  });

  it('shows nothing for a card that was not split', () => {
    view(detail({ status: 'queued' }));
    expect(screen.queryByTestId('split-links')).toBeNull();
  });

  it('offers Send to BA on a draft with no repository, and not on one that has it', () => {
    const first = view(detail({ status: 'draft', stage: 'draft' }));
    expect(screen.getAllByRole('button', { name: 'Send to BA' }).length).toBeGreaterThan(0);
    first.unmount();
    view(detail({ status: 'draft', stage: 'draft', repoId: ID(3) }));
    expect(screen.queryByRole('button', { name: 'Send to BA' })).toBeNull();
  });
});
