import {
  type BoardCard,
  type BoardResponse,
  boardColumns,
  codeWorkflowV1,
  columnFor,
  getStage,
} from '@aom/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { BoardView } from '../components/BoardView.tsx';

type Seed = Pick<BoardCard, 'stage' | 'status' | 'reworkRound' | 'title'> & Partial<BoardCard>;

/** Builds a board the way the server does: columnFor per card, columns in boardColumns order. */
function boardFrom(seeds: Seed[]): BoardResponse {
  const names = boardColumns(codeWorkflowV1);
  const columns = names.map((name) => ({ name, cards: [] as BoardCard[] }));
  seeds.forEach((s, i) => {
    const stage = getStage(codeWorkflowV1, s.stage) ?? codeWorkflowV1.stages[0];
    if (!stage) throw new Error('no stage');
    const col = columnFor(
      { status: s.status, stage: s.stage, reworkRound: s.reworkRound, cardType: s.cardType },
      stage,
    );
    columns
      .find((c) => c.name === col)
      ?.cards.push({
        id: `0192f3a0-0000-7000-8000-00000000010${i}`,
        ref: `TOY-${i + 1}`,
        cardType: 'feature',
        assignee: null,
        updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
        queuedAt: null,
        riskTier: null,
        blocked: s.status === 'blocked',
        priority: 5,
        ...s,
      });
  });
  return { projectId: '0192f3a0-0000-7000-8000-000000000001', workflowKey: 'code', columns };
}

const inColumn = (name: string) => within(screen.getByRole('region', { name }));

describe('Board columns follow columnFor', () => {
  const board = boardFrom([
    { title: 'Draft one', stage: 'spec', status: 'draft', reworkRound: 0 },
    { title: 'Fresh work', stage: 'build', status: 'queued', reworkRound: 0 },
    { title: 'Bounced work', stage: 'build', status: 'queued', reworkRound: 2 },
    {
      title: 'On it',
      stage: 'build',
      status: 'claimed',
      reworkRound: 0,
      assignee: { agentId: '0192f3a0-0000-7000-8000-0000000000aa', name: 'Marlowe' },
      riskTier: 'large',
    },
    { title: 'Stuck', stage: 'build', status: 'blocked', reworkRound: 0 },
    { title: 'Needs review', stage: 'review', status: 'queued', reworkRound: 0 },
    { title: 'Waiting on bug', stage: 'test', status: 'waiting', reworkRound: 0 },
    { title: 'Shipped', stage: 'finalize', status: 'done', reworkRound: 0 },
  ]);

  const renderBoard = () =>
    render(
      <MemoryRouter>
        <BoardView board={board} />
      </MemoryRouter>,
    );

  it('renders the columns in server order', () => {
    renderBoard();
    const names = within(screen.getByTestId('board'))
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.firstChild?.textContent);
    expect(names).toEqual(board.columns.map((c) => c.name));
    expect(names.slice(0, 5)).toEqual(['Spec', 'To do', 'Rework', 'In progress', 'Blocked']);
  });

  it('puts each card under the column columnFor chose', () => {
    renderBoard();
    expect(inColumn('Spec').getByText('Draft one')).toBeInTheDocument();
    expect(inColumn('To do').getByText('Fresh work')).toBeInTheDocument();
    expect(inColumn('Rework').getByText('Bounced work')).toBeInTheDocument();
    expect(inColumn('In progress').getByText('On it')).toBeInTheDocument();
    expect(inColumn('Blocked').getByText('Stuck')).toBeInTheDocument();
    expect(inColumn('Review').getByText('Needs review')).toBeInTheDocument();
    expect(inColumn('Test (waiting on bug)').getByText('Waiting on bug')).toBeInTheDocument();
  });

  it('tiles show ref, assignee, age, risk tier, rework round and blocked badge', () => {
    renderBoard();
    const tile = screen.getByTestId('card-tile-TOY-4');
    expect(within(tile).getByText('TOY-4')).toBeInTheDocument();
    expect(within(tile).getByText('Marlowe')).toBeInTheDocument();
    expect(within(tile).getByText('large')).toBeInTheDocument();
    expect(within(tile).getByText('3h')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-tile-TOY-3')).getByText('Rework 2')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-tile-TOY-5')).getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByTestId('card-tile-TOY-1')).toHaveAttribute(
      'href',
      '/cards/0192f3a0-0000-7000-8000-000000000100', // by card id: refs are only unique per organization
    );
  });

  it('shows the column count', () => {
    renderBoard();
    expect(inColumn('Spec').getByText('1')).toBeInTheDocument();
  });
});
