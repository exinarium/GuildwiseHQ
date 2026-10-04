import type { DeskItemDto, OutboundDraftDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboundHistory } from '../components/OutboundHistory.tsx';
import { diffWords } from '../lib/outbound.ts';
import { DeskItem } from '../pages/Desk.tsx';

const ID = '0192f3a0-0000-7000-8000-000000000001';
const approval: DeskItemDto = {
  id: ID,
  kind: 'approval',
  subkind: 'outbound',
  status: 'open',
  routedTo: 'manager',
  title: 'Approve resolution for Jira ABC-1',
  body: 'The export now includes archived items.',
  doing: '',
  options: [],
  recommendation: null,
  blocking: false,
  pinned: false,
  urgent: false,
  affectedCardIds: ['0192f3a0-0000-7000-8000-0000000000c1'],
  affectedCount: 1,
  askedBy: { kind: 'agent', agentId: '0192f3a0-0000-7000-8000-0000000000a1', agentName: 'Ben', role: 'ba' },
  card: {
    id: '0192f3a0-0000-7000-8000-0000000000c1',
    ref: 'TOY-1',
    title: 'Export',
    stage: 'finalize',
    status: 'queued',
    projectKey: 'TOY',
  },
  projectId: '0192f3a0-0000-7000-8000-0000000000b1',
  dedupEntries: [],
  answer: null,
  answerOption: null,
  answeredAt: null,
  answeredByName: null,
  decisionPolicy: 'owner_only',
  canAnswer: true,
  createdAt: '2026-10-03T10:00:00.000Z',
};

afterEach(() => vi.unstubAllGlobals());
const qc = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

function stubFetch(handler: (url: string, body: unknown) => Response) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      return handler(url, body);
    }),
  );
  return calls;
}
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

const renderItem = (i: DeskItemDto) =>
  render(
    <QueryClientProvider client={qc()}>
      <MemoryRouter>
        <DeskItem item={i} now={Date.parse('2026-10-03T12:00:00.000Z')} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('diffWords', () => {
  it('marks added and removed words and keeps the rest', () => {
    const d = diffWords('The fix is in.', 'The fix is in, thanks.');
    expect(d.map((p) => p.kind)).toContain('added');
    expect(d.filter((p) => p.kind === 'same')[0]?.text).toBe('The fix is ');
    const swap = diffWords('red apple pie', 'green apple pie');
    expect(swap.find((p) => p.kind === 'removed')?.text).toBe('red');
    expect(swap.find((p) => p.kind === 'added')?.text).toBe('green');
    expect(diffWords('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
  });
});

describe('the outbound approval on the desk', () => {
  it('approves the draft as it is', async () => {
    const calls = stubFetch(ok);
    renderItem(approval);
    expect(screen.getByText('Outbound update')).toBeInTheDocument();
    expect(screen.getByTestId('outbound-text')).toHaveValue(approval.body);
    expect(screen.queryByTestId('outbound-diff')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve and post' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: `/api/desk/${ID}/resolve`, body: { resolution: 'approved' } });
  });

  it('shows a diff of the edit and sends the edited text', async () => {
    const calls = stubFetch(ok);
    renderItem(approval);
    const user = userEvent.setup();
    const box = screen.getByTestId('outbound-text');
    await user.clear(box);
    await user.type(box, 'Archived items are exported now.');
    const view = screen.getByTestId('outbound-diff-view');
    expect(view.querySelectorAll('ins').length).toBeGreaterThan(0);
    expect(view.querySelectorAll('del').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Approve and post my edit' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({
      resolution: 'approved',
      editedBody: 'Archived items are exported now.',
    });
  });

  it('rejects with an optional reason', async () => {
    const calls = stubFetch(ok);
    renderItem(approval);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('outbound-reject'));
    await user.type(screen.getByTestId('outbound-reason'), 'not yet');
    await user.click(screen.getByTestId('outbound-reject-confirm'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ resolution: 'rejected', note: 'not yet' });
  });

  it('shows why the server refused an edit that names internal details', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'internal_details',
              message: 'The draft mentions internal details (agent name "Bea").',
            },
          }),
          { status: 422 },
        ),
    );
    renderItem(approval);
    const user = userEvent.setup();
    await user.type(screen.getByTestId('outbound-text'), ' Bea did it.');
    await user.click(screen.getByTestId('outbound-approve'));
    expect(await screen.findByRole('alert')).toHaveTextContent('internal details');
  });
});

const draft = (over: Partial<OutboundDraftDto>): OutboundDraftDto => ({
  id: '0192f3a0-0000-7000-8000-0000000000d1',
  cardId: '0192f3a0-0000-7000-8000-0000000000c1',
  cardRef: 'TOY-1',
  cardTitle: 'Export',
  projectKey: 'TOY',
  externalSystem: 'jira',
  externalKey: 'ABC-1',
  kind: 'resolution',
  body: 'Original text.',
  finalBody: null,
  edited: false,
  status: 'pending',
  deskItemId: ID,
  draftedByName: 'Ben',
  approvedByName: null,
  externalRef: null,
  error: null,
  blockedMatches: [],
  rejectReason: null,
  createdAt: '2026-10-03T10:00:00.000Z',
  approvedAt: null,
  postedAt: null,
  ...over,
});

function renderHistory(drafts: OutboundDraftDto[], isOwner = true) {
  const calls = stubFetch((url) =>
    url.startsWith('/api/outbound?') ? new Response(JSON.stringify({ drafts }), { status: 200 }) : ok(),
  );
  render(
    <QueryClientProvider client={qc()}>
      <MemoryRouter>
        <OutboundHistory
          cardId={drafts[0]?.cardId ?? 'x'}
          cardRef="TOY-1"
          ticket="ABC-1"
          isOwner={isOwner}
          canDraft
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe('the outbound history on a card', () => {
  it('shows the edit that was posted, the result and the states of the others', async () => {
    renderHistory([
      draft({
        id: '0192f3a0-0000-7000-8000-0000000000d2',
        status: 'posted',
        body: 'Original text.',
        finalBody: 'Edited text.',
        edited: true,
        approvedByName: 'Pat',
        externalRef: 'https://jira.example.test/browse/ABC-1?focusedCommentId=1',
      }),
      draft({ id: '0192f3a0-0000-7000-8000-0000000000d3', status: 'rejected', rejectReason: 'not yet' }),
      draft({
        id: '0192f3a0-0000-7000-8000-0000000000d4',
        status: 'blocked',
        blockedMatches: ['agent name "Bea"'],
        deskItemId: null,
      }),
    ]);
    expect(await screen.findByTestId('outbound-diff-0192f3a0-0000-7000-8000-0000000000d2')).toHaveTextContent(
      'Edited',
    );
    expect(screen.getByTestId('outbound-ref-0192f3a0-0000-7000-8000-0000000000d2')).toHaveTextContent(
      'focusedCommentId=1',
    );
    expect(screen.getByText('Rejected, never posted')).toBeInTheDocument();
    expect(screen.getByTestId('outbound-blocked-0192f3a0-0000-7000-8000-0000000000d4')).toHaveTextContent(
      'agent name "Bea"',
    );
  });

  it('a failed post shows the error and the owner can retry it', async () => {
    const id = '0192f3a0-0000-7000-8000-0000000000d5';
    const calls = renderHistory([
      draft({ id, status: 'failed', error: 'Jira answered 401', finalBody: 'x' }),
    ]);
    expect(await screen.findByTestId(`outbound-error-${id}`)).toHaveTextContent('Jira answered 401');
    await userEvent.setup().click(screen.getByTestId(`outbound-retry-${id}`));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/outbound/${id}/retry`)).toBe(true));
  });

  it('only the owner sees Retry', async () => {
    const id = '0192f3a0-0000-7000-8000-0000000000d6';
    renderHistory([draft({ id, status: 'failed', error: 'x' })], false);
    await screen.findByTestId(`outbound-error-${id}`);
    expect(screen.queryByTestId(`outbound-retry-${id}`)).toBeNull();
  });
});
