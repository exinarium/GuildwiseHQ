import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { RunnerUpdateBadge, updateLabel } from '../components/workstations/RunnerUpdateBadge.tsx';
import { PlatformRunners } from '../pages/platform/PlatformRunners.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const update = (state: string, extra: Record<string, unknown> = {}) =>
  ({
    state,
    latestVersion: '0.1.2',
    lastCheckedAt: '2026-10-12T08:00:00.000Z',
    detail: null,
    reportedAt: '2026-10-12T08:00:00.000Z',
    ...extra,
  }) as never;

describe('runner update badge', () => {
  it('says nothing when the runner is up to date or too old to report', () => {
    const { container, rerender } = render(<RunnerUpdateBadge update={update('up_to_date')} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<RunnerUpdateBadge update={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names each state that needs a look', () => {
    expect(updateLabel(update('pending'))?.text).toBe('Update to 0.1.2 pending');
    expect(updateLabel(update('failed'))).toMatchObject({ text: 'Update failed', tone: 'danger' });
    expect(updateLabel(update('rolled_back'))?.text).toBe('Update rolled back');
    expect(updateLabel(update('paused'))?.text).toBe('Updates paused');
    expect(updateLabel(update('unmanaged'))?.text).toBe('Updates by hand');
  });

  it('shows the detail in a tooltip', () => {
    render(<RunnerUpdateBadge update={update('failed', { detail: 'could not install 0.1.2: checksum' })} />);
    expect(screen.getByTestId('runner-update')).toHaveAttribute(
      'title',
      expect.stringContaining('could not install 0.1.2: checksum'),
    );
  });
});

describe('platform runners page', () => {
  let paused = false;
  beforeEach(() => {
    paused = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/api/platform/runner-updates')) {
          if (init?.method === 'PUT') paused = JSON.parse(String(init.body)).paused;
          return json({
            paused,
            updatedAt: paused ? '2026-10-12T08:00:00.000Z' : null,
            latestVersion: '0.1.2',
          });
        }
        return json({});
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('pauses and resumes automatic updates', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter>
            <PlatformRunners />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('runner-updates-state')).toHaveTextContent('On');
    await userEvent.click(screen.getByTestId('runner-updates-toggle'));
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(screen.getByTestId('runner-updates-toggle')).toHaveTextContent('Resume automatic updates');
    await userEvent.click(screen.getByTestId('runner-updates-toggle'));
    expect(await screen.findByText('On')).toBeInTheDocument();
  });
});
