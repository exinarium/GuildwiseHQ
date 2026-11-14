import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrReviewCapPanel } from '../components/PrReviewCapPanel.tsx';

afterEach(() => vi.unstubAllGlobals());

function renderPanel(canChange: boolean, prReviewDailyCap?: number) {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PrReviewCapPanel projectId="p1" project={{ prReviewDailyCap } as never} canChange={canChange} />
    </QueryClientProvider>,
  );
  return fetchMock;
}

describe('the daily cap setting', () => {
  it('shows the default of 20 and saves a new whole number', async () => {
    const fetchMock = renderPanel(true);
    expect(screen.getByTestId('pr-review-cap-state').textContent).toBe('20 per day');
    const input = screen.getByTestId('pr-review-cap-input') as HTMLInputElement;
    expect(input.getAttribute('inputmode')).toBe('numeric');
    expect((screen.getByTestId('pr-review-cap-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('pr-review-cap-save'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c: any[]) => c[0] === '/api/projects/p1/pr-review-cap' && c[1]?.method === 'PUT',
        ),
      ).toBe(true),
    );
  });
  it('refuses 0 and 101 and cannot be changed by a member', () => {
    renderPanel(true, 10);
    const input = screen.getByTestId('pr-review-cap-input');
    for (const bad of ['0', '101', '2.5', '']) {
      fireEvent.change(input, { target: { value: bad } });
      expect(screen.getByText('Enter a whole number from 1 to 100')).toBeTruthy();
      expect((screen.getByTestId('pr-review-cap-save') as HTMLButtonElement).disabled).toBe(true);
    }
  });
  it('a member sees the value but no Save button', () => {
    renderPanel(false, 7);
    expect(screen.getByTestId('pr-review-cap-state').textContent).toBe('7 per day');
    expect(screen.queryByTestId('pr-review-cap-save')).toBeNull();
    expect((screen.getByTestId('pr-review-cap-input') as HTMLInputElement).disabled).toBe(true);
  });
});
