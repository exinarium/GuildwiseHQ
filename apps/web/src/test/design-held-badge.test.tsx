import {
  type BoardCard,
  type BoardResponse,
  boardColumns,
  codeWorkflowV1,
  columnFor,
  getStage,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardView } from '../components/BoardView.tsx';
import { designHeldLabel } from '../components/DesignHeldBadge.tsx';

function setViewport(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: phone ? /max-width:\s*767/.test(query) : /min-width/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function board(designHeld: BoardCard['designHeld']): BoardResponse {
  const columns = boardColumns(codeWorkflowV1).map((name) => ({ name, cards: [] as BoardCard[] }));
  const stage = getStage(codeWorkflowV1, 'investigate') ?? codeWorkflowV1.stages[0];
  if (!stage) throw new Error('no stage');
  const col = columnFor(
    { status: 'queued', stage: 'investigate', reworkRound: 0, cardType: 'feature' },
    stage,
  );
  columns
    .find((c) => c.name === col)
    ?.cards.push({
      id: '0192f3a0-0000-7000-8000-000000000100',
      ref: 'P5-40',
      title: 'Held design',
      cardType: 'feature',
      stage: 'investigate',
      status: 'queued',
      reworkRound: 0,
      assignee: null,
      updatedAt: new Date().toISOString(),
      queuedAt: null,
      riskTier: null,
      blocked: false,
      priority: 5,
      designHeld,
    } as BoardCard);
  return { projectId: '0192f3a0-0000-7000-8000-000000000001', workflowKey: 'code', columns };
}

const renderBoard = (b: BoardResponse) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <BoardView board={b} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => {
  setViewport(false);
});

describe('design held badge', () => {
  it('words the refs: one, two, more than two, none left', () => {
    expect(designHeldLabel({ waitingFor: ['P5-34'] })).toBe('Design ready · waiting for P5-34');
    expect(designHeldLabel({ waitingFor: ['P5-34', 'P5-35'] })).toBe(
      'Design ready · waiting for P5-34, P5-35',
    );
    expect(designHeldLabel({ waitingFor: ['A-1', 'A-2', 'A-3', 'A-4'] })).toBe(
      'Design ready · waiting for A-1, A-2 +2',
    );
    expect(designHeldLabel({ waitingFor: [] })).toBe('Design ready · re-check queued');
  });

  for (const phone of [false, true]) {
    it(`shows on the ${phone ? 'phone' : 'desktop'} board card with an explanation`, () => {
      setViewport(phone);
      renderBoard(board({ waitingFor: ['P5-34'] }));
      const badge = screen.getByTestId('design-held');
      expect(badge.textContent).toBe('Design ready · waiting for P5-34');
      expect(badge.querySelector('[title]')?.getAttribute('title')).toMatch(/design is done/);
    });

    it(`shows nothing on the ${phone ? 'phone' : 'desktop'} board for a card without a held design`, () => {
      setViewport(phone);
      renderBoard(board(undefined));
      expect(screen.queryByTestId('design-held')).toBeNull();
    });
  }
});
