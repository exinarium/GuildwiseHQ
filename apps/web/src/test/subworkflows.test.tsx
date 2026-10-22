import type { BoardCard, BoardResponse, CardDetailResponse, SubworkflowsPanel as Panel } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardView } from '../components/BoardView.tsx';
import { TestingLinks } from '../components/EvidencePanel.tsx';
import {
  cancellableChildren,
  StartedByLine,
  SubworkflowsPanel,
  SubworkflowWaitLine,
} from '../components/SubworkflowsPanel.tsx';
import { CancelDialog } from '../pages/CardDetail.tsx';

afterEach(() => vi.unstubAllGlobals());

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const wrap = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

const tile = (over: Partial<BoardCard>): BoardCard => ({
  id: ID(2),
  ref: 'APP-41',
  title: 'Launch page',
  cardType: 'feature',
  stage: 'translate',
  status: 'queued',
  assignee: null,
  updatedAt: new Date().toISOString(),
  queuedAt: null,
  riskTier: null,
  blocked: false,
  reworkRound: 0,
  priority: 5,
  ...over,
});

const child = (
  over: Partial<Panel['children'][number]['child']> = {},
): Panel['children'][number]['child'] => ({
  id: ID(3),
  ref: 'SUP-12',
  title: 'Translate: Launch page',
  status: 'queued',
  stage: 'translate',
  column: 'Translate',
  projectId: ID(9),
  projectKey: 'SUP',
  projectName: 'Web',
  visible: true,
  fields: { customer: 'Acme' },
  ...over,
});

const run = (over: Partial<Panel['children'][number]> = {}): Panel['children'][number] => ({
  stageId: 'translate',
  stageLabel: 'Translation',
  mode: 'wait',
  state: 'open',
  workflowKey: 'translations',
  workflowVersion: 2,
  startedAt: new Date().toISOString(),
  resolvedAt: null,
  fieldsBack: {},
  child: child(),
  ...over,
});

describe('board: sub-workflow chips', () => {
  const board = (cards: BoardCard[]): BoardResponse => ({
    projectId: ID(1),
    workflowKey: 'launch',
    columns: [{ name: 'Translation', cards }],
  });

  it('a card waiting for its child says what it waits for, where, and links to it', () => {
    wrap(
      <BoardView
        board={board([
          tile({
            status: 'waiting',
            waitingFor: 'subworkflow',
            waitingOn: {
              id: ID(3),
              ref: 'SUP-12',
              title: 'Translate: Launch page',
              column: 'Translate',
              projectKey: 'SUP',
              projectName: 'Web',
            },
          }),
        ])}
      />,
    );
    expect(screen.getByTestId('waiting-badge').textContent).toBe('waiting for sub-workflow');
    const link = screen.getByTestId('waiting-on-link-SUP-12');
    expect(link.getAttribute('href')).toBe(`/cards/${ID(3)}`);
    expect(link.textContent).toBe(
      'Waiting for SUP-12 (Translate: Launch page) in project Web, now in Translate',
    );
  });

  it('a child shows who started it', () => {
    wrap(
      <BoardView
        board={board([tile({ id: ID(3), ref: 'SUP-12', startedBy: { id: ID(2), ref: 'APP-41' } })])}
      />,
    );
    expect(screen.getByTestId('started-by-chip').textContent).toBe('Started by APP-41');
  });

  it('a bug child keeps its old wording', () => {
    wrap(
      <BoardView
        board={board([
          tile({ status: 'waiting', waitingFor: 'bug', waitingOn: { id: ID(4), ref: 'APP-42' } }),
        ])}
      />,
    );
    expect(screen.getByTestId('waiting-badge').textContent).toBe('waiting on bug');
    expect(screen.getByTestId('waiting-on-link-APP-42').textContent).toBe('waiting on APP-42');
  });
});

describe('card detail: sub-workflows', () => {
  it('the panel lists the children with state, mode, the project and the fields passed on and back', () => {
    const data: Panel = {
      startedBy: null,
      children: [
        run(),
        run({
          stageId: 'review',
          stageLabel: 'Legal review',
          state: 'done',
          mode: 'wait',
          fieldsBack: { reply: 'approved' },
          child: child({
            id: ID(5),
            ref: 'LEG-3',
            title: 'Review: Launch page',
            projectKey: 'LEG',
            projectName: 'Legal',
            column: 'Done',
          }),
        }),
      ],
    };
    wrap(<SubworkflowsPanel data={data} />);
    const first = within(screen.getByTestId('subworkflow-SUP-12'));
    expect(first.getByText('Translation')).toBeTruthy();
    expect(first.getByText('Running')).toBeTruthy();
    expect(first.getByText('waits for it')).toBeTruthy();
    expect(first.getByTestId('subworkflow-link-SUP-12').getAttribute('href')).toBe(`/cards/${ID(3)}`);
    expect(first.getByText(/translations v2, project Web, in Translate/)).toBeTruthy();
    expect(first.getByText('Acme')).toBeTruthy();
    const second = within(screen.getByTestId('subworkflow-LEG-3'));
    expect(second.getByText('Finished')).toBeTruthy();
    expect(second.getByTestId('subworkflow-fields-back').textContent).toBe('Copied back: reply = approved');
  });

  it('a child in a project the viewer is not a member of shows only its ref and project key, without a link', () => {
    const data: Panel = {
      startedBy: null,
      children: [
        run({ child: child({ visible: false, title: '', column: null, fields: {}, projectName: 'Secret' }) }),
      ],
    };
    wrap(<SubworkflowsPanel data={data} />);
    expect(screen.queryByTestId('subworkflow-link-SUP-12')).toBeNull();
    expect(screen.queryByText('Secret')).toBeNull();
    expect(screen.queryByText(/Acme/)).toBeNull();
  });

  it('renders nothing for a card without sub-workflows', () => {
    const { container } = wrap(<SubworkflowsPanel data={undefined} />);
    expect(container.textContent).toBe('');
    const empty = wrap(<SubworkflowsPanel data={{ startedBy: null, children: [] }} />);
    expect(empty.container.textContent).toBe('');
  });

  it('the wait line names the open child and its column; a continued or finished child is not waited for', () => {
    wrap(<SubworkflowWaitLine data={{ startedBy: null, children: [run()] }} />);
    expect(screen.getByTestId('subworkflow-wait').textContent).toContain(
      'Waiting for SUP-12 (Translate: Launch page) in project Web, now in Translate',
    );
    const none = wrap(
      <SubworkflowWaitLine
        data={{
          startedBy: null,
          children: [run({ state: 'continued', mode: 'continue' }), run({ state: 'done' })],
        }}
      />,
    );
    expect(none.container.querySelectorAll('[data-testid="subworkflow-wait"]').length).toBe(0);
  });

  it('the child shows its parent and the step that started it', () => {
    wrap(
      <StartedByLine
        data={{
          children: [],
          startedBy: {
            id: ID(2),
            ref: 'APP-41',
            title: 'Launch page',
            stageLabel: 'Translation',
            projectKey: 'APP',
            visible: true,
          },
        }}
      />,
    );
    const line = screen.getByTestId('subworkflow-started-by');
    expect(line.textContent).toBe('Started by APP-41 (Launch page), step "Translation" in project APP.');
    expect(within(line).getByRole('link', { name: 'APP-41' }).getAttribute('href')).toBe(`/cards/${ID(2)}`);
  });

  it('the testing links do not call a sub-workflow wait "a bug fix"', () => {
    const testing = {
      parent: null,
      children: [],
      waitingOn: null,
      parkedOn: null,
    } as unknown as NonNullable<CardDetailResponse['testing']>;
    const { rerender } = wrap(<TestingLinks testing={testing} status="waiting" />);
    // no bug child to wait on: no "waiting on a bug fix" line at all
    expect(screen.queryByTestId('waiting-line')).toBeNull();
    rerender(
      <MemoryRouter>
        <TestingLinks testing={testing} status="waiting" hideWaiting />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('waiting-line')).toBeNull();
  });
});

describe('cancelling a card that waits on a sub-workflow child', () => {
  const panel = (kids: Panel['children']): Panel => ({ children: kids, startedBy: null });
  const mayCancel = (over: Partial<Panel['children'][number]['child']> = {}) =>
    run({ child: child({ canCancel: true, ...over }) });

  it('offers only open children the viewer may cancel, and only while the card waits', () => {
    const data = panel([
      mayCancel(),
      run({ child: child({ id: ID(4), ref: 'SUP-13', canCancel: false }) }),
      run({ state: 'done', child: child({ id: ID(5), ref: 'SUP-14', canCancel: true }) }),
    ]);
    expect(cancellableChildren('waiting', data).map((c) => c.child.ref)).toEqual(['SUP-12']);
    expect(cancellableChildren('queued', data)).toEqual([]);
    expect(cancellableChildren('waiting', undefined)).toEqual([]);
  });

  const mount = (waitingOn: Panel['children']) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
        <CancelDialog open onOpenChange={() => {}} cardId={ID(1)} waitingOn={waitingOn} />
      </QueryClientProvider>,
    );
    return calls;
  };

  it('shows no checkbox when there is no child to cancel, and sends only the reason', async () => {
    const calls = mount([]);
    expect(screen.queryByTestId('cancel-children')).toBeNull();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Reason'), 'stop');
    await user.click(screen.getByRole('button', { name: 'Confirm cancel' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: `/api/cards/${ID(1)}/cancel`, body: { reason: 'stop' } });
  });

  it('names the child, leaves the box unticked, and sends the flag only when it is ticked', async () => {
    const calls = mount([mayCancel()]);
    const box = screen.getByRole('checkbox', {
      name: /Also cancel the card it is waiting for: SUP-12 \(Translate: Launch page\)/,
    });
    expect(box).not.toBeChecked();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Reason'), 'customer left');
    await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Confirm cancel' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ reason: 'customer left', alsoCancelChildren: true });
  });

  it('unticked, the child is not touched', async () => {
    const calls = mount([mayCancel()]);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Reason'), 'just this one');
    await user.click(screen.getByRole('button', { name: 'Confirm cancel' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ reason: 'just this one' });
  });
});
