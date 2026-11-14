import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecondReviewerPanel } from '../components/SecondReviewerPanel.tsx';

afterEach(() => vi.unstubAllGlobals());

function renderPanel(
  secondReviewer: Record<string, unknown>,
  canChange = true,
  response: () => Response = () => new Response('{}', { status: 200 }),
) {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <SecondReviewerPanel
          projectId="p1"
          projectKey="TOY"
          project={{ secondReviewer } as never}
          canChange={canChange}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return fetchMock;
}
const none = { enabled: false, replayId: null, replayRecordedAt: null, precision: null };
const recorded = {
  enabled: false,
  replayId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  replayRecordedAt: '2026-11-01T10:00:00.000Z',
  precision: { first: 0.7, second: 0.8 },
};

describe('the second reviewer switch (AC1)', () => {
  it('is disabled with the replay-first message while no replay is recorded', () => {
    const fetchMock = renderPanel(none);
    const sw = screen.getByTestId('second-reviewer-switch') as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(sw.getAttribute('role')).toBe('switch');
    expect(screen.getByTestId('second-reviewer-replay-required').textContent).toContain('Record a 20-PR replay first');
    fireEvent.click(sw);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with a recorded replay shows its precision and a tap sends PUT enabled:true', async () => {
    const fetchMock = renderPanel(recorded);
    expect(screen.queryByTestId('second-reviewer-replay-required')).toBeNull();
    expect(screen.getByTestId('second-reviewer-replay').textContent).toContain('Sonnet 0.70 · Opus 0.80');
    fireEvent.click(screen.getByTestId('second-reviewer-switch'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c: any[]) =>
            c[0] === '/api/projects/p1/second-reviewer' &&
            c[1]?.method === 'PUT' &&
            JSON.parse(c[1].body).enabled === true,
        ),
      ).toBe(true),
    );
  });

  it('can always be switched off, also when the replay is gone', async () => {
    const fetchMock = renderPanel({ ...none, enabled: true });
    const sw = screen.getByTestId('second-reviewer-switch') as HTMLInputElement;
    expect(sw.disabled).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('a 409 replay_required from the server (a race) is shown next to the switch', async () => {
    renderPanel(recorded, true, () =>
      new Response(JSON.stringify({ error: { code: 'replay_required', message: 'record a replay' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    fireEvent.click(screen.getByTestId('second-reviewer-switch'));
    await waitFor(() => expect(screen.getByTestId('second-reviewer-race')).toBeTruthy());
  });

  it('a member who is not the owner sees read-only text and a disabled switch', () => {
    renderPanel(recorded, false);
    expect(screen.getByTestId('second-reviewer-readonly').textContent).toContain('Only the project owner');
    expect((screen.getByTestId('second-reviewer-switch') as HTMLInputElement).disabled).toBe(true);
  });
});
