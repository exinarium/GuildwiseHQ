import type { BoardCard, Workability } from '@aom/shared';
import { render, screen, waitFor } from '@testing-library/react';
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

  it('red and accessible for a card nobody could take, with the reason and a prefilled hire link', async () => {
    renderTile(blocked);
    const warn = screen.getByTestId('workability-warning');
    expect(warn).toHaveAttribute('data-level', 'blocked');
    const button = screen.getByRole('button', { name: blocked.reason as string });
    expect(button.className).toContain('text-danger');
    // the reason is the popover the button points at (hover, keyboard focus or a click open it)
    await userEvent.click(button);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'needs a second senior reviewer other than Linus',
    );
    expect(button).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
    const hire = await screen.findByTestId('workability-hire');
    expect(hire).toHaveTextContent('Hire senior reviewer');
    expect(hire).toHaveAttribute('href', `/agents?hire=reviewer&seniority=senior&projectId=${PROJECT}`);
  });

  it('amber for waiting, without a hire link', () => {
    renderTile(waiting);
    expect(screen.getByTestId('workability-warning')).toHaveAttribute('data-level', 'waiting');
    expect(screen.getByRole('button', { name: 'Waiting: Reviewer Linus is offline.' }).className).toContain(
      'text-warning',
    );
    expect(screen.queryByTestId('workability-hire')).toBeNull();
  });

  it('the icon is not nested inside the tile link (no interactive content inside a link)', () => {
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
    await userEvent.click(screen.getByTestId('workability-warning').querySelector('button') as HTMLElement);
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
  });

  it('the reason is reachable by click, outside the card (a portal escapes overflow-hidden), and Esc closes it', async () => {
    renderTile(waiting);
    expect(screen.queryByTestId('workability-reason')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: waiting.reason as string }));
    const reason = await screen.findByTestId('workability-reason');
    expect(reason).toHaveTextContent('Reviewer Linus is offline');
    expect(screen.getByTestId('card-tile-TOY-1').contains(reason)).toBe(false);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('workability-reason')).toBeNull());
  });

  it('opens on keyboard focus', async () => {
    renderTile(waiting);
    await userEvent.tab(); // the tile link
    await userEvent.tab();
    expect(await screen.findByTestId('workability-reason')).toHaveTextContent('offline');
  });

  it('a runner rejection for the working branch links to the repository settings', async () => {
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
    await userEvent.click(screen.getByRole('button'));
    expect(await screen.findByTestId('workability-reason')).toHaveTextContent('Last attempt failed');
    expect(screen.getByTestId('workability-settings')).toHaveAttribute(
      'href',
      `/projects/${PROJECT}/settings#repos`,
    );
    expect(screen.queryByTestId('workability-hire')).toBeNull();
  });
});
