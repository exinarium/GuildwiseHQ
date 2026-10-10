import type { BoardCard } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { CardTile } from '../components/BoardView.tsx';

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';

const tile = (extra: Partial<BoardCard> = {}): BoardCard => ({
  id: '0192f3a0-0000-7000-8000-000000000101',
  ref: 'TOY-1',
  title: 'Big refactor',
  cardType: 'feature',
  stage: 'build',
  status: 'queued',
  assignee: null,
  updatedAt: new Date().toISOString(),
  queuedAt: null,
  riskTier: null,
  blocked: false,
  reworkRound: 0,
  priority: 2,
  ...extra,
});

const renderTile = (card: BoardCard) =>
  render(
    <MemoryRouter>
      <ul>
        <CardTile card={card} projectId={PROJECT} />
      </ul>
    </MemoryRouter>,
  );

describe('board card notices', () => {
  it('shows none for a plain card', () => {
    renderTile(tile());
    for (const id of ['blocked-reason', 'budget-warning', 'hygiene-warning'])
      expect(screen.queryByTestId(id)).toBeNull();
  });

  it('writes the reason behind Blocked and links to the desk', () => {
    renderTile(
      tile({
        status: 'blocked',
        blocked: true,
        blockedReason: { deskItemId: PROJECT, kind: 'question', title: 'Which database?', others: 1 },
      }),
    );
    expect(screen.getByTestId('blocked-reason-text').textContent).toBe(
      'Blocked: Which database? (and 1 more)',
    );
    expect(screen.getByTestId('blocked-reason-fix').getAttribute('href')).toBe('/desk');
  });

  it('shows the hygiene problem with a link to the repository settings', () => {
    renderTile(tile({ hygiene: [{ kind: 'conflict', repoName: 'toy', detail: 'conflict in a.ts' }] }));
    expect(screen.getByTestId('hygiene-warning-text').textContent).toBe('toy: Conflict while updating');
    expect(screen.getByTestId('hygiene-fix').getAttribute('href')).toBe(
      `/projects/${PROJECT}/settings#repos`,
    );
  });

  it('shows the budget notice; the fix link only for those who can edit the budget', () => {
    const budget = { state: 'paused' as const, percent: 104, resetsAt: new Date().toISOString() };
    const { unmount } = renderTile(tile({ budget: { ...budget, canEdit: true } }));
    expect(screen.getByTestId('budget-warning-text').textContent).toContain(
      'monthly budget is used up (104% spent)',
    );
    expect(screen.getByTestId('budget-fix').getAttribute('href')).toBe(
      `/projects/${PROJECT}/settings#budget`,
    );
    unmount();
    renderTile(tile({ budget: { ...budget, percent: null, canEdit: false } }));
    expect(screen.getByTestId('budget-warning-text').textContent).not.toContain('%');
    expect(screen.queryByTestId('budget-fix')).toBeNull();
  });
});
