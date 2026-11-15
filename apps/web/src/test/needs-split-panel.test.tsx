import type { CardDetailResponse } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { NeedsSplitPanel, NeedsSplitSummary } from '../components/NeedsSplitPanel.tsx';

const proposal = {
  reason: 'Estimated 1400 changed lines against a budget of 400.',
  folderScope: ['apps/server/src/commands', 'apps/web/src/components/a/very/long/folder/path/that/wraps'],
  seams: [
    { title: 'Server transition', folders: ['apps/server/src/commands'], note: 'and the route' },
    {
      title: 'Web panel',
      folders: ['apps/web/src/components/a/very/long/folder/path/that/wraps'],
      repo: 'web',
    },
  ],
  estimate: { size: 1400, budget: 400, unit: 'changed_lines' },
};
const record = (over: Partial<NonNullable<CardDetailResponse['needsSplit']>> = {}) =>
  ({
    state: 'with_ba',
    reason: 'first',
    round: 1,
    fromStage: 'investigate',
    requestedAt: '2026-11-12T10:00:00.000Z',
    proposal,
    taskId: null,
    deskItemId: null,
    inheritedFromCardId: null,
    childCardIds: [],
    note: null,
    ...over,
  }) as NonNullable<CardDetailResponse['needsSplit']>;

const renderPanel = (needsSplit: CardDetailResponse['needsSplit']) =>
  render(
    <MemoryRouter>
      <NeedsSplitPanel needsSplit={needsSplit} />
    </MemoryRouter>,
  );

describe('NeedsSplitPanel', () => {
  it('shows the folder scope and the seams of a card with the BA', () => {
    renderPanel(record());
    expect(screen.getByTestId('needs-split-panel')).toBeTruthy();
    expect(screen.getByText('With the BA to split')).toBeTruthy();
    const chips = screen.getAllByTestId('needs-split-folder').map((c) => c.textContent);
    for (const f of proposal.folderScope) expect(chips).toContain(f);
    // long folders break instead of overflowing a phone screen
    expect(screen.getAllByTestId('needs-split-folder')[0]!.className).toContain('break-all');
    const seams = screen.getAllByTestId('needs-split-seam').map((s) => s.textContent);
    expect(seams[0]).toContain('1. Server transition');
    expect(seams[1]).toContain('Web panel');
    expect(seams[1]).toContain('(web)');
    expect(screen.getByTestId('needs-split-estimate').textContent).toContain(
      '1400 changed lines, budget 400',
    );
    expect(screen.queryByTestId('needs-split-desk-link')).toBeNull();
    // read-only: nothing to type into
    expect(document.querySelector('input, textarea')).toBeNull();
  });

  it('links to the desk when the owner decides, with a 44px tap target', () => {
    renderPanel(
      record({ state: 'owner', reason: 'second_time', deskItemId: '00000000-0000-4000-8000-000000000009' }),
    );
    expect(screen.getByText('Waiting for the owner')).toBeTruthy();
    const link = screen.getByTestId('needs-split-desk-link');
    expect(link.getAttribute('href')).toBe('/desk');
    expect(link.className).toContain('min-h-11');
  });

  it('says the split was dropped when the BA task ended without one', () => {
    renderPanel(record({ state: 'dropped' }));
    expect(screen.getByText('Not split: the BA task ended')).toBeTruthy();
    expect(screen.queryByText('With the BA to split')).toBeNull();
  });

  it('shows nothing for a card that never took the route', () => {
    const { container } = renderPanel(null);
    expect(container.textContent).toBe('');
  });
});

describe('NeedsSplitSummary (desk)', () => {
  it('shows the folder scope and seam titles of the item', () => {
    render(<NeedsSplitSummary data={{ reason: 'second_time', proposal, fromStage: 'investigate' }} />);
    expect(screen.getByTestId('needs-split-summary')).toBeTruthy();
    expect(screen.getAllByTestId('needs-split-seam')).toHaveLength(2);
  });

  it('shows nothing without a proposal', () => {
    const { container } = render(<NeedsSplitSummary data={{}} />);
    expect(container.textContent).toBe('');
  });
});
