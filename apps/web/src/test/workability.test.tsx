import type { BoardCard, Workability } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { CardTile } from '../components/BoardView.tsx';
import { WorkabilityWarning } from '../components/WorkabilityWarning.tsx';

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const blocked: Workability = {
  ok: false,
  level: 'blocked',
  reason:
    'Not workable: this large change needs a second senior reviewer other than Linus. Hire another senior reviewer.',
  hire: { roleKey: 'reviewer', seniority: 'senior' },
};
const waiting: Workability = { ok: false, level: 'waiting', reason: 'Waiting: Reviewer Linus is offline.' };

const tile = (workability?: Workability): BoardCard => ({
  id: '0192f3a0-0000-7000-8000-000000000101',
  ref: 'TOY-1',
  title: 'Big refactor',
  cardType: 'feature',
  stage: 'review',
  status: 'queued',
  assignee: null,
  updatedAt: new Date().toISOString(),
  queuedAt: null,
  riskTier: 'large',
  blocked: false,
  reworkRound: 0,
  priority: 2,
  ...(workability ? { workability } : {}),
});

const renderTile = (w?: Workability) =>
  render(
    <MemoryRouter>
      <ul>
        <CardTile card={tile(w)} projectId={PROJECT} />
      </ul>
    </MemoryRouter>,
  );

describe('workability warning', () => {
  it('shows nothing for a workable card', () => {
    renderTile({ ok: true });
    expect(screen.queryByTestId('workability-warning')).toBeNull();
    renderTile();
    expect(screen.queryByTestId('workability-warning')).toBeNull();
  });

  it('red banner on the card for a card nobody could take: the reason written out, a prefilled hire link', () => {
    renderTile(blocked);
    const warn = screen.getByTestId('workability-warning');
    expect(warn).toHaveAttribute('data-level', 'blocked');
    expect(warn.className).toContain('text-danger-soft-fg');
    // the reason is text on the card (not a hidden tooltip) and the hover title
    expect(screen.getByTestId('workability-warning-text')).toHaveTextContent(
      'needs a second senior reviewer other than Linus',
    );
    expect(warn).toHaveAttribute('title', blocked.reason as string);
    const hire = screen.getByTestId('workability-hire');
    expect(hire).toHaveTextContent('Hire senior reviewer');
    expect(hire).toHaveAttribute('href', `/agents?hire=reviewer&seniority=senior&projectId=${PROJECT}`);
  });

  it('a long reason is cut to two lines and unfolds in place on tap, with aria-expanded', async () => {
    renderTile(blocked);
    const text = screen.getByTestId('workability-warning-text');
    expect(text.className).toContain('line-clamp-2');
    const toggle = screen.getByRole('button', { name: 'Show the full reason' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', text.id);
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    expect(text.className).not.toContain('line-clamp-2');
  });

  it('amber for waiting, without a hire link', () => {
    renderTile(waiting);
    const warn = screen.getByTestId('workability-warning');
    expect(warn).toHaveAttribute('data-level', 'waiting');
    expect(warn.className).toContain('text-warning-soft-fg');
    expect(warn).toHaveTextContent('Waiting: Reviewer Linus is offline.');
    expect(screen.queryByTestId('workability-hire')).toBeNull();
  });

  it('the banner is not nested inside the tile link (no interactive content inside a link)', () => {
    renderTile(blocked);
    expect(screen.getByTestId('card-tile-TOY-1').contains(screen.getByTestId('workability-warning'))).toBe(
      false,
    );
  });

  it('is usable on its own (card detail)', async () => {
    render(
      <MemoryRouter>
        <WorkabilityWarning workability={blocked} projectId={PROJECT} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('workability-warning')).toHaveTextContent('second senior reviewer');
  });

  it('a runner rejection for the working branch is written on the card and links to the repository settings', () => {
    render(
      <MemoryRouter>
        <WorkabilityWarning
          workability={{
            ok: false,
            level: 'waiting',
            reason:
              "Last attempt failed: working branch 'main' does not exist in Barcode Camera (default branch is master). Fix the working branch in project settings.",
            settings: 'repositories',
          }}
          projectId={PROJECT}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('workability-warning')).toHaveTextContent('Last attempt failed');
    expect(screen.getByTestId('workability-settings')).toHaveAttribute(
      'href',
      `/projects/${PROJECT}/settings#repos`,
    );
    expect(screen.queryByTestId('workability-hire')).toBeNull();
  });
});
