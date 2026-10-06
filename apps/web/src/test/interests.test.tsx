import type { InterestDto, ProjectDto, ScheduleDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cronOf, emptyValues, validateInterest } from '../lib/interests.ts';
import { Interests } from '../pages/Interests.tsx';
import { Schedules } from '../pages/Schedules.tsx';
import { keysForEvent } from '../ws/invalidate.ts';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wrap = (node: React.ReactNode, path = '/') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
};

const U = (n: number) => `0192f3a0-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`;
const project = (
  n: number,
  key: string,
  workflowKey: string,
  over: Partial<ProjectDto> = {},
): ProjectDto => ({
  id: U(n),
  orgId: U(99),
  key,
  name: `${key} project`,
  domain: 'personal',
  workflowKey,
  priorityTier: 2,
  branchPrefix: 'aom/',
  workingBranch: 'main',
  subCategories: ['rust/async'],
  vaultFolder: null,
  architecturalGlobs: [],
  e2eGlobs: [],
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  myRole: 'owner',
  ...over,
});
const NEWS = project(1, 'NEWS', 'feed');
const RES = project(2, 'RES', 'research');

const stats = {
  lastScanAt: '2026-10-05T05:02:00.000Z',
  lastScanCard: { id: U(50), ref: 'NEWS-41', status: 'done' },
  nextScanAt: '2026-10-06T05:00:00.000Z',
  scans30d: 6,
  items: { total: 22, last30d: 22, lastScan: 6 },
  ratings: { useful: 12, irrelevant: 3, boring: 5, unrated: 2 },
  research: { open: 1, published: 2 },
  failing: false,
};
const interest = (over: Partial<InterestDto> = {}): InterestDto => ({
  id: U(10),
  orgId: U(99),
  name: 'Rust async',
  description: 'Deep dives on tokio internals',
  feedProject: { id: NEWS.id, key: 'NEWS', name: 'News', archived: false },
  researchProject: { id: RES.id, key: 'RES', name: 'Research', archived: false },
  subCategory: 'rust/async',
  preferredSites: ['lobste.rs'],
  scan: { cron: '0 7 * * *', timezone: 'Africa/Johannesburg', windowHours: 24, maxItems: 10, manual: false },
  status: 'active',
  scheduleId: U(20),
  adoptedFrom: null,
  canManage: true,
  canRun: true,
  canResearch: true,
  tasteRuleCount: 1,
  schedule: { id: U(20), enabled: true, nextFireAt: stats.nextScanAt, failCount: 0, lastError: null },
  stats,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

interface Call {
  method: string;
  url: string;
  body: any;
}
function stubApi(
  interests: InterestDto[],
  calls: Call[],
  extra: { adoptable?: unknown[]; adoptableCount?: number } = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') {
        if (url.startsWith('/api/interests/adoptable')) return json({ schedules: extra.adoptable ?? [] });
        if (url.startsWith('/api/interests/')) {
          const found = interests.find((i) => url.includes(i.id));
          return found
            ? json({
                interest: found,
                scans: [],
                publications: [],
                taste: { rules: ['Skip beginner tutorials'], version: 2, hasVault: true },
              })
            : json({}, 404);
        }
        if (url.startsWith('/api/interests'))
          return json({
            interests,
            tasteProjects: [
              {
                projectId: NEWS.id,
                key: 'NEWS',
                name: 'News',
                ruleCount: 3,
                version: 4,
                hasVault: true,
                canManage: true,
              },
            ],
            adoptableCount: extra.adoptableCount ?? 0,
          });
        if (url.startsWith('/api/projects/') && url.endsWith('/taste-seed'))
          return json({
            projectId: NEWS.id,
            version: 4,
            rules: [{ text: 'Prefer primary sources', interestId: null }],
            hasVault: true,
          });
        if (url.startsWith('/api/projects')) return json({ projects: [NEWS, RES] });
        return json({});
      }
      const body = JSON.parse(String(init.body ?? '{}'));
      calls.push({ method, url, body });
      if (url.endsWith('/run')) return json({ cardId: U(60), ref: 'NEWS-42' }, 201);
      if (url === '/api/cards') return json({ card: { id: U(61), ref: 'RES-7' } }, 201);
      if (url === '/api/interests') return json({ id: U(11) }, 201);
      if (url === '/api/interests/adopt')
        return json(
          {
            results: body.scheduleIds.map((id: string, n: number) =>
              n === 0
                ? { scheduleId: id, interestId: U(12) }
                : { scheduleId: id, error: 'project is archived' },
            ),
          },
          200,
        );
      return json({ ok: true });
    }),
  );
}

describe('lib/interests', () => {
  it('validates the form: name, a project, cron, max items', () => {
    const v = emptyValues('UTC');
    expect(validateInterest(v)).toMatchObject({ name: expect.any(String), project: expect.any(String) });
    expect(validateInterest({ ...v, name: 'X', feedProjectId: NEWS.id })).toEqual({});
    expect(
      validateInterest({ ...v, name: 'X', feedProjectId: NEWS.id, preset: 'custom', cron: 'nope' }).cron,
    ).toBeTruthy();
    expect(
      validateInterest({ ...v, name: 'X', feedProjectId: NEWS.id, maxItems: '500' }).maxItems,
    ).toBeTruthy();
    expect(
      validateInterest({ ...v, name: 'X', newFeed: true, newFeedKey: 'a', newFeedName: '' }).newFeed,
    ).toBeTruthy();
    expect(cronOf({ preset: 'weekdays-0700', cron: '' })).toBe('0 7 * * 1-5');
  });
  it('maps interest and schedule events to query keys', () => {
    const keys = keysForEvent({ type: 'InterestUpdated', streamId: `interest-${U(10)}`, projectId: NEWS.id });
    expect(keys).toContainEqual(['interests']);
    expect(keys).toContainEqual(['schedules']);
    expect(
      keysForEvent({ type: 'ScheduleLinked', streamId: `schedule-${U(20)}`, projectId: NEWS.id }),
    ).toContainEqual(['interests']);
    expect(
      keysForEvent({ type: 'TasteSeedSet', streamId: `project-${NEWS.id}`, projectId: NEWS.id }),
    ).toContainEqual(['taste']);
  });
});

describe('Interests page', () => {
  it('lists an interest with its cadence, last scan, ratings and failing badge', async () => {
    stubApi(
      [
        interest(),
        interest({
          id: U(13),
          name: 'Broken',
          stats: { ...stats, failing: true },
          schedule: { id: U(21), enabled: true, nextFireAt: null, failCount: 3, lastError: 'no repo' },
        }),
      ],
      [],
    );
    wrap(<Interests />);
    const card = await screen.findByTestId('interest-Rust async');
    expect(within(card).getByTestId('interest-cadence')).toHaveTextContent(
      'Daily at 07:00 (Africa/Johannesburg) · 24 h · 10 items',
    );
    expect(within(card).getByTestId('interest-last-scan')).toHaveTextContent('NEWS-41');
    expect(within(card).getByTestId('interest-ratings')).toHaveTextContent(
      'useful 12 · irrelevant 3 · boring 5 · unrated 2',
    );
    expect(within(card).getByTestId('interest-notes-line')).toHaveTextContent('Notes 2 · open 1');
    const broken = screen.getByTestId('interest-Broken');
    expect(within(broken).getByText(/Cannot run \(3 tries\)/)).toBeInTheDocument();
    expect(screen.getByTestId('taste-project-NEWS')).toHaveTextContent(
      '3 explicit rules · written to taste.md v4',
    );
  });

  it('runs an interest now and links Digests to the filtered feed', async () => {
    const calls: Call[] = [];
    stubApi([interest()], calls);
    wrap(<Interests />);
    const card = await screen.findByTestId('interest-Rust async');
    expect(within(card).getByTestId('interest-digests')).toHaveAttribute(
      'href',
      `/p/NEWS/feed?interest=${U(10)}`,
    );
    await userEvent.setup().click(within(card).getByTestId('interest-run'));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'POST', url: `/api/interests/${U(10)}/run` }),
      ),
    );
    expect(await within(card).findByTestId('interest-run-result')).toHaveTextContent('NEWS-42');
  });

  it('hides run and research for a member who cannot, and shows View instead of Edit', async () => {
    stubApi([interest({ canManage: false, canRun: false, canResearch: false })], []);
    wrap(<Interests />);
    const card = await screen.findByTestId('interest-Rust async');
    expect(within(card).queryByTestId('interest-run')).toBeNull();
    expect(within(card).queryByTestId('interest-research')).toBeNull();
    expect(within(card).queryByTestId('interest-toggle')).toBeNull();
    expect(within(card).getByTestId('interest-edit')).toHaveTextContent('View');
  });

  it('creates an interest with an inline new feed project', async () => {
    const calls: Call[] = [];
    stubApi([], calls);
    wrap(<Interests />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('interest-new'));
    const drawer = await screen.findByTestId('interest-drawer');
    // empty form: validation errors, nothing sent
    await user.click(within(drawer).getByTestId('interest-save'));
    expect(await within(drawer).findByText('A name is required')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await user.type(within(drawer).getByTestId('interest-name'), 'AI feeds');
    await user.selectOptions(within(drawer).getByTestId('interest-feed-project'), '__new');
    expect(within(drawer).getByTestId('new-feed-key')).toHaveValue('AF');
    await user.click(within(drawer).getByTestId('interest-save'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/interests' });
    expect(calls[0]?.body).toMatchObject({
      name: 'AI feeds',
      newFeedProject: { key: 'AF', name: 'AI feeds', domain: 'personal' },
      scan: { cron: '0 7 * * *', maxItems: 10, manual: false },
    });
  });

  it('is read-only for a guest and a full-screen sheet on phones (class check)', async () => {
    stubApi([interest({ canManage: false })], []);
    wrap(<Interests />);
    await userEvent.setup().click(await screen.findByTestId('interest-edit'));
    const drawer = await screen.findByTestId('interest-drawer');
    expect(drawer.className).toContain('inset-0');
    expect(drawer.className).toContain('sm:w-[480px]');
    expect(within(drawer).getByTestId('interest-name')).toBeDisabled();
    expect(within(drawer).getByTestId('interest-save')).toBeDisabled();
    expect(within(drawer).getByText(/not a member of every project/)).toBeInTheDocument();
  });

  it('saves edits and the interest taste rules (PATCH, then PUT taste)', async () => {
    const calls: Call[] = [];
    stubApi([interest()], calls);
    wrap(<Interests />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('interest-edit'));
    const drawer = await screen.findByTestId('interest-drawer');
    await waitFor(() => expect(within(drawer).getAllByTestId('taste-rule')).toHaveLength(1));
    await user.type(within(drawer).getByTestId('taste-rule-input'), 'Prefer primary sources');
    await user.click(within(drawer).getByTestId('taste-rule-add'));
    const desc = within(drawer).getByTestId('interest-description');
    await user.clear(desc);
    await user.type(desc, 'new angle');
    await user.click(within(drawer).getByTestId('interest-save'));
    await waitFor(() =>
      expect(calls.map((c) => c.method + c.url)).toEqual([
        `PATCH/api/interests/${U(10)}`,
        `PUT/api/interests/${U(10)}/taste`,
      ]),
    );
    expect(calls[0]?.body).toMatchObject({
      description: 'new angle',
      feedProjectId: NEWS.id,
      researchProjectId: RES.id,
      status: 'active',
    });
    expect(calls[1]?.body).toEqual({ rules: ['Skip beginner tutorials', 'Prefer primary sources'] });
  });

  it('Research this prefills the dialog and sends interestId with specify', async () => {
    const calls: Call[] = [];
    stubApi([interest()], calls);
    wrap(<Interests />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('interest-research'));
    const dialog = await screen.findByTestId('research-dialog');
    expect(within(dialog).getByTestId('research-title')).toHaveValue('Research: Rust async');
    expect(within(dialog).getByTestId('research-question')).toHaveValue(
      'What should I know now about Rust async?',
    );
    await user.click(within(dialog).getByTestId('research-submit'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/cards' });
    expect(calls[0]?.body).toMatchObject({
      projectId: RES.id,
      cardType: 'research',
      interestId: U(10),
      specify: true,
      fields: {
        question: 'What should I know now about Rust async?',
        depth: 'standard',
        subCategory: 'rust/async',
        scope: 'Deep dives on tokio internals',
        preferredSites: ['lobste.rs'],
      },
    });
    expect(await screen.findByTestId('research-card-link')).toHaveTextContent('RES-7');
  });

  it('Save as draft sends specify false', async () => {
    const calls: Call[] = [];
    stubApi([interest()], calls);
    wrap(<Interests />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('interest-research'));
    await user.click(await screen.findByTestId('research-draft'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body.specify).toBe(false);
  });

  it('shows the adopt banner and reports the result per schedule', async () => {
    const calls: Call[] = [];
    const sched = (n: number, name: string) => ({
      id: U(30 + n),
      name,
      projectId: NEWS.id,
      projectKey: 'NEWS',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
      topic: name,
    });
    stubApi([], calls, { adoptableCount: 2, adoptable: [sched(1, 'First'), sched(2, 'Second')] });
    wrap(<Interests />);
    const user = userEvent.setup();
    expect(await screen.findByTestId('adopt-banner')).toHaveTextContent(
      '2 feed schedules are not interests yet',
    );
    await user.click(
      within(screen.getByTestId('adopt-banner')).getByRole('button', { name: 'Review and adopt' }),
    );
    const dialog = await screen.findByTestId('adopt-dialog');
    await within(dialog).findByTestId('adopt-row-First');
    await user.click(within(dialog).getByTestId('adopt-submit'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ scheduleIds: [U(31), U(32)] });
    const results = await within(dialog).findAllByTestId('adopt-result');
    expect(results.map((r) => r.textContent)).toEqual(['Adopted', 'project is archived']);
  });
});

describe('Schedules page with interests', () => {
  const schedule = (over: Partial<ScheduleDto>): ScheduleDto => ({
    id: U(20),
    projectId: NEWS.id,
    projectKey: 'NEWS',
    projectName: 'News',
    name: 'Rust async',
    kind: 'feed',
    cron: '0 7 * * *',
    timezone: 'UTC',
    cardTemplate: { title: 'Rust async', fields: { topic: 'Rust async' } },
    enabled: true,
    nextFireAt: '2026-10-06T07:00:00.000Z',
    lastFiredAt: null,
    lastCardId: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over,
  });
  it('locks a linked schedule: run now stays, edit controls are replaced by a link to the interest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/schedules'))
          return json({
            schedules: [
              schedule({ interestId: U(10), interestName: 'Rust async' }),
              schedule({ id: U(21), name: 'Plain' }),
            ],
          });
        if (url.startsWith('/api/projects')) return json({ projects: [NEWS] });
        return json({});
      }),
    );
    wrap(<Schedules />);
    const linked = await screen.findByTestId('schedule-Rust async');
    expect(within(linked).getByRole('button', { name: 'Run now' })).toBeInTheDocument();
    expect(within(linked).queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(within(linked).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(linked).getByTestId('schedule-managed')).toHaveTextContent(
      'Managed by interest Rust async',
    );
    expect(within(linked).getByRole('link', { name: 'Rust async' })).toHaveAttribute(
      'href',
      `/interests?open=${U(10)}`,
    );
    const plain = screen.getByTestId('schedule-Plain');
    expect(within(plain).getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByTestId('schedules-interests-hint')).toHaveTextContent(
      'Feeds are easier to manage as Interests',
    );
  });
});
