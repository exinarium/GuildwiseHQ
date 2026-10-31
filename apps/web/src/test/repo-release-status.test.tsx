import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseStatus } from '../components/WorkingBranchControl.tsx';

const ALERT = '019e3f6a-7b1c-7a2d-8c3e-0123456789e1';
const ship = {
  version: '1.4.0',
  status: 'committed',
  step: 'land',
  commit: 'a'.repeat(40),
  error: null,
  branch: 'develop',
  updatedAt: '2026-11-01T10:00:00.000Z',
};
const repo = (over: Record<string, unknown> = {}) =>
  ({ id: 'r1', name: 'toy', releaseProposal: null, lastRelease: null, ...over }) as never;

const wrap = (el: React.ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('ReleaseStatus', () => {
  it('shows the last release with its tag and release page links', () => {
    wrap(
      <ReleaseStatus
        repo={repo({
          lastRelease: {
            version: '1.4.0',
            tag: 'v1.4.0',
            tagUrl: 'https://github.com/o/r/tree/v1.4.0',
            releaseUrl: 'https://github.com/o/r/releases/tag/v1.4.0',
            releasePage: true,
            at: '2026-11-02T10:00:00.000Z',
            source: 'guildwise',
          },
        })}
      />,
    );
    expect(screen.getByText('1.4.0')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tag v1.4.0' }).getAttribute('href')).toBe(
      'https://github.com/o/r/tree/v1.4.0',
    );
    expect(screen.getByRole('link', { name: 'Release page' }).getAttribute('href')).toContain(
      '/releases/tag/',
    );
  });

  it('says there is no release page on a git host without them, and shows plain text without a tag link', () => {
    wrap(
      <ReleaseStatus
        repo={repo({
          lastRelease: {
            version: '1.4.0',
            tag: 'v1.4.0',
            tagUrl: null,
            releaseUrl: null,
            releasePage: false,
            at: '2026-11-02T10:00:00.000Z',
            source: 'guildwise',
          },
        })}
      />,
    );
    expect(screen.getByText(/no release page/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('v1.4.0')).toBeTruthy();
  });

  it('shows the wait for the release PR with its link', () => {
    wrap(
      <ReleaseStatus
        repo={repo({
          releaseProposal: {
            state: 'approved',
            deskItemId: ALERT,
            version: '1.4.0',
            ship: {
              ...ship,
              prUrl: 'https://github.com/o/r/pull/7',
              message: 'the release pull request is not merged yet',
            },
          },
        })}
      />,
    );
    expect(screen.getByTestId('release-progress').textContent).toContain('not merged yet');
    expect(screen.getByRole('link', { name: 'View the pull request' }).getAttribute('href')).toContain(
      '/pull/7',
    );
  });

  it("shows the failure message and Retry posts 'approved' to the alert; a refusal appears inline", async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'only the project owner can decide' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      );
    wrap(
      <ReleaseStatus
        repo={repo({
          releaseProposal: {
            state: 'approved',
            deskItemId: ALERT,
            version: '1.4.0',
            ship: {
              ...ship,
              status: 'failed',
              step: 'tag',
              error: 'pushing v1.4.0 failed: tags are locked',
              alertDeskItemId: ALERT,
            },
          },
        })}
      />,
    );
    expect(screen.getByTestId('release-failed').textContent).toContain('tags are locked');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain(`/desk/${ALERT}/resolve`);
    expect(JSON.parse(String(init.body))).toMatchObject({ resolution: 'approved' });
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});
