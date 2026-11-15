import type { DeskItemDto, PrReviewDto } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SizeExceptionDeskItem, sizeAgainstBudget } from '../components/desk/SizeExceptionDeskItem.tsx';
import { SizeCheckInfo } from '../components/pull-requests/SizeCheckInfo.tsx';
import { ToastProvider } from '../components/ui.tsx';

const mutate = vi.hoisted(() => vi.fn());
vi.mock('../api/queries/desk.ts', () => ({
  useResolveDeskItem: () => ({ mutate, isPending: false, error: null }),
}));

const item = {
  id: '0192f3a0-0000-7000-8000-0000000000d1',
  kind: 'approval',
  subkind: 'size_exception',
  status: 'open',
  title: 'Size exception: PR #7',
  body: '',
  data: {
    reason: 'The generated client is one change and cannot be split.',
    size: 1240,
    budget: 800,
    unit: 'changed_lines',
    url: 'https://github.com/acme/toy/pull/7',
    dueAt: '2030-03-05T15:00:00.000Z',
  },
} as unknown as DeskItemDto;

beforeEach(() => mutate.mockReset());

describe('GWP-210 AC1: the desk item shows the reason and the size against the budget', () => {
  it('formats the size', () => {
    expect(sizeAgainstBudget(item.data as never)).toBe('1,240 of 800 changed lines, 155%');
  });

  it('shows the reason, the size, the answer-by line and no dismiss or snooze', () => {
    render(
      <ToastProvider>
        <SizeExceptionDeskItem item={item} />
      </ToastProvider>,
    );
    expect(screen.getByTestId('size-exception-size').textContent).toBe('1,240 of 800 changed lines, 155%');
    expect(screen.getByTestId('size-exception-reason').textContent).toContain('generated client');
    expect(screen.getByTestId('size-exception-due').textContent).toContain('will not be reminded');
    expect(screen.queryByText(/dismiss|snooze/i)).toBeNull();
  });
});

describe('AC2 and AC3: approve and reject send the owner decision with the note', () => {
  it('approve', async () => {
    render(
      <ToastProvider>
        <SizeExceptionDeskItem item={item} />
      </ToastProvider>,
    );
    await userEvent.type(screen.getByLabelText('Note (optional)'), ' fine ');
    await userEvent.click(screen.getByTestId('size-exception-approve'));
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      id: item.id,
      body: { resolution: 'approved', note: 'fine' },
    });
  });
  it('reject', async () => {
    render(
      <ToastProvider>
        <SizeExceptionDeskItem item={item} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByTestId('size-exception-reject'));
    expect(mutate.mock.calls[0]?.[0]).toEqual({ id: item.id, body: { resolution: 'rejected' } });
  });
});

describe('the pull request line', () => {
  const pr = (over: Partial<PrReviewDto>) =>
    ({ changeId: '7', state: 'not_reviewed', size: null, split: null, ...over }) as PrReviewDto;
  it('says a request is pending, approved, or not approved', () => {
    const { rerender } = render(
      <SizeCheckInfo
        pr={pr({
          state: 'size_exception_pending',
          sizeException: { id: 'x', state: 'pending', dueAt: '2030-03-05T15:00:00.000Z', size: 900 },
          size: { state: 'over', total: 900, budget: 600, unit: 'changed_lines' },
        })}
      />,
    );
    expect(screen.getByTestId('pr-size-exception-pending-7').textContent).toContain(
      '900 of 600 changed lines',
    );
    rerender(
      <SizeCheckInfo
        pr={pr({
          sizeException: { id: 'x', state: 'approved', dueAt: '2030-03-05T15:00:00.000Z', size: 900 },
          size: { state: 'over', total: 900, budget: 600, unit: 'changed_lines' },
        })}
      />,
    );
    expect(screen.getByTestId('pr-size-exception-approved-7').textContent).toContain(
      'up to 900 changed lines',
    );
    rerender(
      <SizeCheckInfo
        pr={pr({
          state: 'needs_split',
          split: {
            reason: 'size_exception_lapsed',
            total: 900,
            budget: 600,
            unit: 'changed_lines',
            members: [],
            at: null,
            notice: null,
          },
        })}
      />,
    );
    expect(screen.getByTestId('pr-split-detail-7').textContent).toContain('Size exception lapsed');
  });
});
