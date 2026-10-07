import type { ProjectDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDangerZone } from '../components/ProjectDangerZone.tsx';
import { Projects } from '../pages/Projects.tsx';

const mk = (over: Partial<ProjectDto> = {}): ProjectDto => ({
  id: '0192f3a0-0000-7000-8000-000000000001',
  orgId: '0192f3a0-0000-7000-8000-0000000000a1',
  key: 'TOY',
  name: 'Toy',
  workflowKey: 'code',
  rank: 1,
  branchPrefix: 'aom/',
  workingBranch: 'main',
  subCategories: [],
  vaultFolder: null,
  architecturalGlobs: [],
  e2eGlobs: [],
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  myRole: 'owner',
  ...over,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const calls = () =>
  fetchMock.mock.calls.map(([u, i]) => `${(i as RequestInit | undefined)?.method ?? 'GET'} ${u}`);

function renderWith(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('project settings: danger zone', () => {
  it('archive asks first and lists what will stop, then archives', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/impact'))
        return json({ activeShifts: 2, openCards: 7, schedules: 1, openDeskItems: 3 });
      return json({});
    });
    renderWith(<ProjectDangerZone project={mk()} />);
    expect(calls()).toEqual([]);
    await user.click(screen.getByTestId('archive-project'));
    const dialog = await screen.findByTestId('archive-dialog');
    await waitFor(() =>
      expect(within(dialog).getByTestId('impact-shifts')).toHaveTextContent('2 active shifts'),
    );
    expect(within(dialog).getByTestId('impact-cards')).toHaveTextContent('7 open cards');
    expect(within(dialog).getByTestId('impact-schedules')).toHaveTextContent('1 schedule will stop');
    expect(calls()).not.toContain('POST /api/projects/0192f3a0-0000-7000-8000-000000000001/archive');

    await user.click(screen.getByTestId('archive-confirm'));
    await waitFor(() =>
      expect(calls()).toContain('POST /api/projects/0192f3a0-0000-7000-8000-000000000001/archive'),
    );
  });

  it('cancelling the dialog archives nothing', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () =>
      json({ activeShifts: 0, openCards: 0, schedules: 0, openDeskItems: 0 }),
    );
    renderWith(<ProjectDangerZone project={mk()} />);
    await user.click(screen.getByTestId('archive-project'));
    await screen.findByTestId('archive-dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls().some((c) => c.includes('/archive'))).toBe(false);
  });

  it('an archived project offers Restore instead', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(json({}));
    renderWith(<ProjectDangerZone project={mk({ status: 'archived' })} />);
    expect(screen.queryByTestId('archive-project')).toBeNull();
    expect(screen.getByTestId('archived-note')).toHaveTextContent('archived');
    await user.click(screen.getByTestId('restore-project'));
    await waitFor(() =>
      expect(calls()).toContain('POST /api/projects/0192f3a0-0000-7000-8000-000000000001/restore'),
    );
  });
});

describe('projects page: archived section', () => {
  const owned = mk({ id: '0192f3a0-0000-7000-8000-000000000002', key: 'OLD', name: 'Old one' });
  const shared = mk({
    id: '0192f3a0-0000-7000-8000-000000000003',
    key: 'SHR',
    name: 'Shared old',
    myRole: 'manager',
  });
  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/projects?status=archived'))
        return json({
          projects: [
            { ...owned, status: 'archived' },
            { ...shared, status: 'archived' },
          ],
        });
      if (url.startsWith('/api/projects')) return json({ projects: [mk()] });
      if (url.includes('invitations')) return json({ invitations: [] });
      return json({});
    });
  });

  it('shows archived projects only under the Archived filter; Restore for members, Delete for the owner', async () => {
    const user = userEvent.setup();
    renderWith(<Projects />);
    expect(await screen.findByText('Toy')).toBeInTheDocument();
    expect(screen.queryByTestId('archived-projects')).toBeNull();
    expect(screen.queryByText('Old one')).toBeNull();

    await user.click(screen.getByTestId('filter-archived'));
    const section = await screen.findByTestId('archived-projects');
    expect(await within(section).findByText('Old one')).toBeInTheDocument();
    expect(within(section).getByTestId('restore-OLD')).toBeInTheDocument();
    expect(within(section).getByTestId('delete-OLD')).toBeInTheDocument();
    // a manager of a shared project may restore but not delete
    expect(within(section).getByTestId('restore-SHR')).toBeInTheDocument();
    expect(within(section).queryByTestId('delete-SHR')).toBeNull();

    await user.click(within(section).getByTestId('restore-SHR'));
    await waitFor(() =>
      expect(calls()).toContain('POST /api/projects/0192f3a0-0000-7000-8000-000000000003/restore'),
    );
  });

  it('delete needs the project key typed before it is enabled, then posts the key', async () => {
    const user = userEvent.setup();
    renderWith(<Projects />);
    await user.click(await screen.findByTestId('filter-archived'));
    await user.click(await screen.findByTestId('delete-OLD'));
    const confirm = await screen.findByTestId('delete-confirm');
    expect(confirm).toBeDisabled();
    const input = screen.getByTestId('delete-confirm-input');
    await user.type(input, 'ol');
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'OLD');
    expect(confirm).toBeEnabled();
    expect(calls().some((c) => c.endsWith('/delete'))).toBe(false);

    await user.click(confirm);
    await waitFor(() => {
      const i = fetchMock.mock.calls.findIndex(([u]) =>
        String(u).endsWith('/0192f3a0-0000-7000-8000-000000000002/delete'),
      );
      expect(i).toBeGreaterThanOrEqual(0);
      const init = (fetchMock.mock.calls[i] ?? [])[1] as RequestInit;
      expect(JSON.parse(String(init.body))).toEqual({ confirmKey: 'OLD' });
    });
  });
});
