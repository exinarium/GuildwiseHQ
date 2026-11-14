import { ACCOUNTING_TEMPLATE_ID, JOURNEY_TEMPLATES } from '@aom/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JourneyTemplateGallery } from '../components/journeys/JourneyTemplateGallery.tsx';

describe('JourneyTemplateGallery', () => {
  it('lists every template with industry badges on the tagged ones', () => {
    render(<JourneyTemplateGallery templates={JOURNEY_TEMPLATES} onPick={vi.fn()} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const item = (name: string) => items.find((i) => within(i).queryByText(name))!;
    expect(within(item('Rentals: lead to monthly rent')).queryByText(/^(Accounting|Law)$/)).toBeNull();
    expect(within(item('Accounting: client onboarding to filing')).getByText('Accounting')).toBeTruthy();
    expect(within(item('Law: matter intake to close-out')).getByText('Law')).toBeTruthy();
    expect(screen.getByText('11 steps · for a client')).toBeTruthy();
    expect(screen.getByText('10 steps · for a client')).toBeTruthy();
    expect(screen.getByText('10 steps · for a matter')).toBeTruthy();
  });

  it('picks the template whose button was clicked', async () => {
    const onPick = vi.fn();
    render(<JourneyTemplateGallery templates={JOURNEY_TEMPLATES} onPick={onPick} />);
    const li = screen
      .getAllByRole('listitem')
      .find((i) => within(i).queryByText('Accounting: client onboarding to filing'))!;
    await userEvent.click(within(li).getByRole('button', { name: 'Use this template' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0].id).toBe(ACCOUNTING_TEMPLATE_ID);
  });
});
