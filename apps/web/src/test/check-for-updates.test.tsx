import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CheckForUpdates,
  OLD_RUNNER_HINT,
  updateCheckText,
} from '../components/workstations/CheckForUpdates.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ws = (over: Record<string, unknown> = {}, check: Record<string, unknown> = {}) =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Desk',
    connected: true,
    runnerVersion: '0.1.34',
    updateCheck: {
      supported: true,
      state: 'idle',
      requestedAt: null,
      nextAllowedAt: null,
      result: null,
      ...check,
    },
    ...over,
  }) as never;

const at = '2026-10-20T08:00:00.000Z';
const renderIt = (w: never) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <CheckForUpdates w={w} />
    </QueryClientProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('check for updates button', () => {
  it('asks the server to check and shows the pending state', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, requestedAt: at }, 202));
    vi.stubGlobal('fetch', fetchMock);
    renderIt(ws());
    await userEvent.click(screen.getByTestId('update-check-button'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/workstations/11111111-1111-4111-8111-111111111111/update-check'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('shows checking while the runner has not answered', () => {
    renderIt(ws({}, { state: 'checking', requestedAt: at }));
    const b = screen.getByTestId('update-check-button');
    expect(b).toBeDisabled();
    expect(b).toHaveTextContent('Checking...');
  });

  it('is disabled with a hint for a runner that is too old', () => {
    renderIt(ws({}, { supported: false }));
    expect(screen.getByTestId('update-check-button')).toBeDisabled();
    expect(screen.getByTestId('update-check-button').parentElement).toHaveAttribute('title', OLD_RUNNER_HINT);
  });

  it('is disabled while the workstation is offline', () => {
    renderIt(ws({ connected: false }));
    expect(screen.getByTestId('update-check-button')).toBeDisabled();
    expect(screen.getByTestId('update-check-button').parentElement).toHaveAttribute(
      'title',
      'This workstation is offline.',
    );
  });

  it('is enabled for a capable, connected runner', () => {
    renderIt(ws());
    expect(screen.getByTestId('update-check-button')).toBeEnabled();
    expect(screen.queryByTestId('update-check-result')).toBeNull();
  });

  it('shows the runner answer inline', () => {
    const r = (outcome: string, version: string | null, detail: string | null = null) => ({
      outcome,
      version,
      detail,
      at,
    });
    const { unmount } = renderIt(ws({}, { result: r('up_to_date', '0.1.34') }));
    expect(screen.getByTestId('update-check-result')).toHaveTextContent('Up to date (0.1.34)');
    unmount();
    const b = renderIt(ws({}, { result: r('update_found', '0.1.35') }));
    expect(screen.getByTestId('update-check-result')).toHaveTextContent(
      'Update 0.1.35 found: installs when idle',
    );
    b.unmount();
    const c = renderIt(ws({}, { result: r('failed', null, 'no route') }));
    expect(screen.getByTestId('update-check-result')).toHaveTextContent('Check failed: no route');
    c.unmount();
    renderIt(ws({}, { state: 'timed_out', requestedAt: at }));
    expect(screen.getByTestId('update-check-result')).toHaveTextContent('The runner did not answer');
  });

  it('words each outcome', () => {
    expect(updateCheckText({ outcome: 'paused', version: null, detail: null }, '0.1.34')).toBe(
      'Updates are paused',
    );
    expect(updateCheckText({ outcome: 'disabled', version: null, detail: null }, '0.1.34')).toBe(
      'Updates are turned off on this machine',
    );
  });

  it('shows the server error (rate limit) inline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(
          {
            error: {
              code: 'rate_limited',
              message: 'A check was asked for a moment ago. Try again in a minute.',
            },
          },
          429,
        ),
      ),
    );
    renderIt(ws());
    await userEvent.click(screen.getByTestId('update-check-button'));
    expect(await screen.findByTestId('update-check-result')).toHaveTextContent(/moment ago/);
  });
});
