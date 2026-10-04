import type { DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerText, choiceFor, defaultOption, deskKindLabel, sortDeskItems } from '../lib/desk.ts';
import { DeskItem } from '../pages/Desk.tsx';

const base: DeskItemDto = {
  id: '0192f3a0-0000-7000-8000-000000000001',
  kind: 'question',
  subkind: null,
  status: 'open',
  routedTo: 'manager',
  title: 'Tabs or spaces?',
  body: '',
  doing: 'writing the formatter',
  options: [
    { id: 'o1', label: 'tabs' },
    { id: 'o2', label: 'spaces' },
  ],
  recommendation: 'o2',
  blocking: true,
  pinned: true,
  urgent: true,
  affectedCardIds: ['0192f3a0-0000-7000-8000-0000000000c1', '0192f3a0-0000-7000-8000-0000000000c2'],
  affectedCount: 2,
  askedBy: {
    kind: 'agent',
    agentId: '0192f3a0-0000-7000-8000-0000000000a1',
    agentName: 'Ada',
    role: 'builder',
  },
  card: {
    id: '0192f3a0-0000-7000-8000-0000000000c1',
    ref: 'TOY-1',
    title: 'Add greeting',
    stage: 'build',
    status: 'blocked',
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
const item = (over: Partial<DeskItemDto>): DeskItemDto => ({ ...base, ...over });

afterEach(() => vi.unstubAllGlobals());

function renderItem(i: DeskItemDto) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DeskItem item={i} now={Date.parse('2026-10-03T12:00:00.000Z')} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('desk ordering', () => {
  const mk = (id: string, o: Partial<DeskItemDto>) => ({ id, ...pick(item(o)) });
  const pick = (i: DeskItemDto) => ({
    pinned: i.pinned,
    blocking: i.blocking,
    affectedCount: i.affectedCount,
    createdAt: i.createdAt,
  });

  it('sorts pinned, blocking, affected-card count, then oldest first', () => {
    const list = [
      mk('plain-old', {
        pinned: false,
        blocking: false,
        affectedCount: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
      mk('blocking-1', {
        pinned: true,
        blocking: true,
        affectedCount: 1,
        createdAt: '2026-10-02T00:00:00.000Z',
      }),
      mk('blocking-3-new', {
        pinned: true,
        blocking: true,
        affectedCount: 3,
        createdAt: '2026-10-03T00:00:00.000Z',
      }),
      mk('blocking-3-old', {
        pinned: true,
        blocking: true,
        affectedCount: 3,
        createdAt: '2026-10-02T12:00:00.000Z',
      }),
      mk('alert-pinned', {
        pinned: true,
        blocking: false,
        affectedCount: 9,
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
      mk('plain-many', {
        pinned: false,
        blocking: false,
        affectedCount: 5,
        createdAt: '2026-10-03T00:00:00.000Z',
      }),
    ];
    expect(sortDeskItems(list).map((i) => i.id)).toEqual([
      'blocking-3-old',
      'blocking-3-new',
      'blocking-1',
      'alert-pinned',
      'plain-many',
      'plain-old',
    ]);
    // Does not mutate its input.
    expect(list[0]?.id).toBe('plain-old');
  });
});

describe('answer helpers', () => {
  it('preselects the recommendation only when it is one of the options', () => {
    expect(defaultOption(base)).toBe('o2');
    expect(defaultOption(item({ recommendation: 'o9' }))).toBeNull();
    expect(defaultOption(item({ recommendation: null }))).toBeNull();
  });
  it('answers with the note, else the chosen option label', () => {
    expect(answerText('  use tabs, please ', 'o2', base.options)).toBe('use tabs, please');
    expect(answerText('', 'o2', base.options)).toBe('spaces');
    expect(answerText('', null, base.options)).toBe('');
  });
  it('maps the ledger choices', () => {
    expect(choiceFor('decision')).toEqual({ scope: 'decision' });
    expect(choiceFor('standing_org')).toEqual({ scope: 'standing_order', orgWide: true });
  });
});

describe('desk kind labels', () => {
  it.each([
    ['question', null, 'Question'],
    ['approval', null, 'Approval'],
    ['approval', 'devops', 'DevOps approval'],
    ['approval', 'outbound', 'Outbound update'],
    ['approval', 'large_merge', 'Merge approval'],
    ['approval', 'repo_create', 'Create repository'],
    ['alert', 'repo_create_failed', 'Repository not created'],
    ['rating', 'digest', 'Digest to rate'],
    ['escalation', null, 'Escalation'],
    ['escalation', 'vault_conflict', 'Vault conflict'],
    ['alert', 'tester_bottleneck', 'Tester bottleneck'],
    ['alert', 'some_new_thing', 'Some new thing'],
  ] as const)('%s / %s is "%s"', (kind, subkind, label) => {
    expect(deskKindLabel({ kind, subkind })).toBe(label);
    renderItem(item({ kind, subkind }));
    expect(screen.getByTestId('desk-kind')).toHaveTextContent(label);
  });
});

describe('DeskItem', () => {
  it('shows who asks, the card, what they were doing, options with the recommendation preselected, and the badges', () => {
    renderItem(base);
    expect(screen.getByTestId('urgent-badge')).toHaveTextContent('Urgent');
    expect(screen.getByTestId('asked-by')).toHaveTextContent('Ada');
    expect(screen.getByTestId('asked-by')).toHaveTextContent('builder');
    expect(screen.getByTestId('item-card')).toHaveTextContent('TOY-1 Add greeting');
    expect(screen.getByTestId('item-doing')).toHaveTextContent('writing the formatter');
    expect(screen.getByRole('heading', { name: 'Tabs or spaces?' })).toBeInTheDocument();
    expect(screen.getByText('Blocking')).toBeInTheDocument();
    expect(screen.getByTestId('affected-count')).toHaveTextContent('Affects 2 cards');
    expect(screen.getByRole('radio', { name: /spaces/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /tabs/ })).not.toBeChecked();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });

  it('has no urgent badge for a non-blocking, unpinned item', () => {
    renderItem(item({ pinned: false, urgent: false, blocking: false, affectedCount: 1 }));
    expect(screen.queryByTestId('urgent-badge')).toBeNull();
    expect(screen.getByText('Non-blocking')).toBeInTheDocument();
    expect(screen.getByTestId('affected-count')).toHaveTextContent('Affects 1 card');
  });

  it('is read only when the user may not answer', () => {
    renderItem(item({ canAnswer: false }));
    expect(screen.getByTestId('read-only')).toHaveTextContent('only the card owner can answer');
    expect(screen.queryByRole('form', { name: 'Answer' })).toBeNull();
  });

  it('lists similar ledger entries the agent was shown', () => {
    renderItem(
      item({
        dedupEntries: [
          {
            id: '0192f3a0-0000-7000-8000-0000000000e1',
            scope: 'decision',
            title: 'Indentation',
            body: 'Use tabs.',
          },
        ],
      }),
    );
    expect(screen.getByTestId('dedup-entries')).toHaveTextContent('Indentation');
  });

  it('submits the preselected option and the chosen ledger scope', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    renderItem(base);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Add to ledger as'), 'Standing order (every project)');
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe(`/api/desk/${base.id}/answer`);
    expect(calls[0]?.body).toEqual({
      answer: 'spaces',
      optionId: 'o2',
      ledger: { scope: 'standing_order', orgWide: true },
    });
  });

  it('asks for an answer when there is no option and no text', async () => {
    renderItem(item({ options: [], recommendation: null }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Answer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose an option or write an answer');
  });

  it.each([
    [
      'with options',
      [
        { id: 'retry', label: 'Retry' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
    ],
    ['stored by the old code without options', []],
  ])('a failed repository creation alert %s offers Retry and Dismiss', async (_n, options) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    renderItem(item({ kind: 'alert', subkind: 'repo_create_failed', options, blocking: false }));
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: `/api/desk/${base.id}/resolve`, body: { resolution: 'approved' } });
  });

  it('a failed repository creation alert is read only for someone who is not the project owner', () => {
    renderItem(item({ kind: 'alert', subkind: 'repo_create_failed', options: [], canAnswer: false }));
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByTestId('read-only')).toBeInTheDocument();
  });

  it('approvals offer approve/reject instead of a text answer', () => {
    renderItem(item({ kind: 'approval', subkind: 'large_merge', options: [], blocking: false }));
    expect(screen.getByRole('button', { name: 'Approve merge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Answer' })).toBeNull();
  });
});
