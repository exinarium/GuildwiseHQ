import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoSyncLine, syncReason, syncText } from '../components/RepoSync.tsx';
import { lastActivityAt, minutesWord, ShiftClock, ShiftStopControls } from '../components/ShiftStop.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const calls: Array<{ method: string; url: string; body?: unknown }> = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ ok: true });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  );
};

const cardShift = { id: ID(1), cardId: ID(2), cardRef: 'TOY-1', agentName: 'Mel' };

describe('stopping a shift', () => {
  it('"Stop and re-queue" stops without keeping the card', async () => {
    const user = userEvent.setup();
    wrap(<ShiftStopControls shift={cardShift} />);
    await user.click(screen.getByTestId('stop-shift'));
    await user.click(screen.getByTestId('stop-requeue'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/shifts/${ID(1)}/stop`)).toMatchObject({
        method: 'POST',
        body: {},
      }),
    );
  });

  it('"Stop, keep the card with this agent" asks for keepCard', async () => {
    const user = userEvent.setup();
    wrap(<ShiftStopControls shift={cardShift} />);
    await user.click(screen.getByTestId('stop-shift'));
    await user.click(screen.getByTestId('stop-keep'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/shifts/${ID(1)}/stop`)?.body).toEqual({ keepCard: true }),
    );
  });

  it('a shift without a card has a single stop', async () => {
    const user = userEvent.setup();
    wrap(<ShiftStopControls shift={{ ...cardShift, cardId: null, cardRef: null }} />);
    await user.click(screen.getByTestId('stop-shift'));
    expect(screen.queryByTestId('stop-keep')).toBeNull();
    await user.click(screen.getByTestId('stop-confirm'));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/shifts/${ID(1)}/stop`)).toBe(true));
  });

  it('"Stop the running command" calls kill-tools and leaves the shift alone', async () => {
    const user = userEvent.setup();
    wrap(<ShiftStopControls shift={cardShift} />);
    await user.click(screen.getByTestId('kill-tools'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/shifts/${ID(1)}/kill-tools`)?.method).toBe('POST'),
    );
    expect(calls.some((c) => c.url.endsWith('/stop'))).toBe(false);
  });

  it('shows how long it runs and when it last did something', () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const shift = {
      startedAt: iso(25 * 60_000),
      progressTail: [{ at: iso(12 * 60_000), kind: 'tool' as const, text: 'Bash: dotnet test' }],
    };
    expect(lastActivityAt(shift)).toBe(shift.progressTail[0]?.at);
    wrap(<ShiftClock shift={shift} />);
    expect(screen.getByText(/Running 25 min/)).toBeInTheDocument();
    expect(screen.getByText(/last activity 12 min ago/)).toBeInTheDocument();
    expect(minutesWord(3 * 3_600_000 + 5 * 60_000)).toBe('3 h 5 min');
  });
});

const sync = (over: Record<string, unknown> = {}) => ({
  workingBranch: 'alex/dev',
  state: 'behind' as const,
  ahead: 0,
  behind: 3,
  dirty: false,
  onBranch: true,
  checkedOutBranch: 'alex/dev',
  checkedAt: new Date().toISOString(),
  ...over,
});

describe('working branch sync line', () => {
  it('says how far behind and offers Sync now', async () => {
    const user = userEvent.setup();
    wrap(<RepoSyncLine sync={sync()} workstationId={ID(7)} repoId={ID(8)} canSync />);
    expect(screen.getByText('alex/dev is 3 commits behind origin')).toBeInTheDocument();
    await user.click(screen.getByTestId('sync-now'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        url: `/api/workstations/${ID(7)}/repos/${ID(8)}/sync`,
      }),
    );
  });

  it('names diverged and uncommitted changes, and says so when in step', () => {
    expect(syncText(sync({ state: 'diverged', ahead: 2, behind: 1 }) as never)?.text).toMatch(/diverged/);
    expect(syncText(sync({ state: 'dirty', dirty: true }) as never)?.text).toMatch(/uncommitted changes/);
    expect(syncText(sync({ state: 'synced', behind: 0, dirty: false }) as never)).toEqual({
      text: 'alex/dev is in sync with origin',
      tone: 'success',
    });
    expect(syncText(sync({ state: 'updated', behind: 0, dirty: true }) as never)?.text).toMatch(
      /in sync with origin \(your checkout has uncommitted changes\)/,
    );
  });

  it('hides Sync now where the user may not sync', () => {
    wrap(<RepoSyncLine sync={sync()} workstationId={ID(7)} repoId={ID(8)} canSync={false} />);
    expect(screen.queryByTestId('sync-now')).toBeNull();
  });

  it('shows why a sync left the branch alone, with a warning badge rather than an error', () => {
    wrap(
      <RepoSyncLine
        sync={
          sync({
            reason: 'checked-out-elsewhere',
            reasonMessage: 'alex/dev is checked out in another worktree (~/wt2); it was left alone',
          }) as never
        }
        workstationId={ID(7)}
        repoId={ID(8)}
        canSync
      />,
    );
    const badge = screen.getByTestId('repo-sync-reason');
    expect(badge).toHaveTextContent('Left unchanged: alex/dev is checked out in another worktree (~/wt2)');
    expect(badge.className).toContain('bg-warning-soft');
    expect(badge.className).not.toContain('danger');
    expect(screen.getByText('alex/dev is 3 commits behind origin')).toBeInTheDocument();
  });

  it('shows no reason without one, after an update, or for a quiet code', () => {
    const { unmount } = wrap(<RepoSyncLine sync={sync()} workstationId={ID(7)} repoId={ID(8)} canSync />);
    expect(screen.queryByTestId('repo-sync-reason')).toBeNull();
    unmount();
    wrap(
      <RepoSyncLine
        sync={
          sync({
            state: 'updated',
            behind: 0,
            reason: 'checked-out-elsewhere',
            reasonMessage: 'old',
          }) as never
        }
        workstationId={ID(7)}
        repoId={ID(8)}
        canSync
      />,
    );
    expect(screen.queryByTestId('repo-sync-reason')).toBeNull();
    expect(screen.getByText('alex/dev is in sync with origin')).toBeInTheDocument();
    expect(
      syncReason(sync({ state: 'synced', behind: 0, reason: 'up-to-date', reasonMessage: 'x' }) as never),
    ).toBeNull();
    expect(
      syncReason(sync({ state: 'ahead', ahead: 1, behind: 0, reason: 'local-ahead' }) as never),
    ).toBeNull();
  });

  it('falls back to a fixed text when the message is missing, and uses a neutral tone for expected skips', () => {
    expect(syncReason(sync({ reason: 'checked-out-elsewhere' }) as never)).toEqual({
      text: 'checked out in another worktree, so it was left alone',
      tone: 'warning',
    });
    expect(
      syncReason(sync({ state: 'busy', reason: 'shift-running', reasonMessage: 'm' }) as never)?.tone,
    ).toBe('neutral');
  });

  it('shows a line for no remote and a missing local branch, and does not repeat the detail next to a reason', () => {
    expect(syncText(sync({ state: 'no_remote' }) as never)?.text).toMatch(/no origin remote/);
    expect(syncText(sync({ state: 'missing_branch' }) as never)?.text).toMatch(/no local branch/);
    wrap(
      <RepoSyncLine
        sync={sync({ state: 'no_remote' }) as never}
        workstationId={ID(7)}
        repoId={ID(8)}
        canSync
      />,
    );
    expect(screen.getByTestId('repo-sync')).toBeInTheDocument();
    expect(
      syncText(sync({ state: 'dirty', detail: 'uncommitted changes would be overwritten: c.txt' }) as never)
        ?.text,
    ).toMatch(/c\.txt/);
    expect(
      syncText(
        sync({
          state: 'dirty',
          detail: 'uncommitted changes would be overwritten: c.txt',
          reason: 'local-changes',
        }) as never,
      )?.text,
    ).not.toMatch(/c\.txt/);
  });
});
