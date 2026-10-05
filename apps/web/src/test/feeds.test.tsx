import type { DeskItemDto, DigestItemDto, ProjectDto, ScheduleDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFeedTemplate, defaultTimezone, describeCron, parseSites } from '../lib/feeds.ts';
import { DeskItem } from '../pages/Desk.tsx';
import { Schedules } from '../pages/Schedules.tsx';

afterEach(() => vi.unstubAllGlobals());

const wrap = (node: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
};

const digestItem = (n: number, over: Partial<DigestItemDto> = {}): DigestItemDto => ({
  id: `0192f3a0-0000-7000-8000-00000000d0${n}`,
  cardId: '0192f3a0-0000-7000-8000-0000000000c1',
  cardRef: 'NEWS-1',
  projectId: '0192f3a0-0000-7000-8000-0000000000b1',
  projectKey: 'NEWS',
  kind: 'article',
  url: `https://news.example.test/story-${n}`,
  title: `Headline ${n}`,
  source: 'News Example',
  publishedAt: '2026-10-02T00:00:00.000Z',
  summary: `Summary ${n}`,
  transcript: null,
  verdict: null,
  verdictReason: null,
  ratedAt: null,
  deskItemId: '0192f3a0-0000-7000-8000-0000000000e1',
  createdAt: '2026-10-03T07:00:00.000Z',
  ...over,
});

const ratingItem = (digestItems: DigestItemDto[], over: Partial<DeskItemDto> = {}): DeskItemDto => ({
  id: '0192f3a0-0000-7000-8000-0000000000e1',
  kind: 'rating',
  subkind: 'digest',
  status: 'open',
  routedTo: 'manager',
  title: 'Rate the News digest (2 items)',
  body: '- Headline 1\n- Headline 2',
  doing: '',
  options: [],
  recommendation: null,
  blocking: false,
  pinned: false,
  urgent: false,
  affectedCardIds: [],
  affectedCount: 0,
  askedBy: { kind: 'agent', agentId: null, agentName: 'Cora', role: 'curator' },
  card: null,
  projectId: '0192f3a0-0000-7000-8000-0000000000b1',
  dedupEntries: [],
  answer: null,
  answerOption: null,
  answeredAt: null,
  answeredByName: null,
  decisionPolicy: null,
  canAnswer: true,
  createdAt: '2026-10-03T07:00:00.000Z',
  digestItems,
  ...over,
});

describe('digest links (review low)', () => {
  it('renders only http(s) item URLs as links', () => {
    const bad = digestItem(1, { url: 'javascript:alert(1)', title: 'Evil item' });
    const good = digestItem(2, { url: 'https://example.test/a', title: 'Good item' });
    wrap(<DeskItem item={ratingItem([bad, good])} now={Date.parse('2026-10-03T12:00:00.000Z')} />);
    expect(screen.getByText('Evil item').closest('a')).toBeNull();
    expect(screen.getByText('Good item').closest('a')?.getAttribute('href')).toBe('https://example.test/a');
  });
});

describe('feed helpers', () => {
  it('names presets and falls back to the cron expression', () => {
    expect(describeCron('0 7 * * *')).toBe('Daily at 07:00');
    expect(describeCron(' 0  7 * * 1-5 ')).toBe('Weekdays at 07:00');
    expect(describeCron('15 3 * * 2')).toBe('Cron 15 3 * * 2');
    expect(defaultTimezone()).toMatch(/\w/);
  });

  it('parses preferred sites and builds the feed card template with a description and one maximum number of items', () => {
    expect(parseSites('https://a.test, https://b.test\n\n c.test ')).toEqual([
      'https://a.test',
      'https://b.test',
      'c.test',
    ]);
    expect(
      buildFeedTemplate({
        title: ' Daily firearms ',
        topic: ' reloading ',
        sites: 'https://a.test',
        description: '  Deep dives only.\n\nNo news.  ',
        maxItems: 'x',
      }),
    ).toEqual({
      title: 'Daily firearms',
      cardType: 'feed',
      fields: {
        topic: 'reloading',
        description: 'Deep dives only.\n\nNo news.',
        windowHours: 24,
        preferredSites: ['https://a.test'],
        maxItems: 10,
      },
    });
  });
});

describe('digest rating on the desk', () => {
  it('lists the digest items with source and summary and rates one with a reason', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const items = [
      digestItem(1),
      digestItem(2, { verdict: 'boring', verdictReason: 'Seen it', ratedAt: '2026-10-03T08:00:00.000Z' }),
    ];
    wrap(<DeskItem item={ratingItem(items)} now={Date.parse('2026-10-03T12:00:00.000Z')} />);

    expect(screen.getByRole('heading', { name: /Rate the News digest/ })).toBeInTheDocument();
    const first = screen.getByTestId(`digest-item-${items[0]?.id}`);
    expect(within(first).getByRole('link', { name: 'Headline 1' })).toHaveAttribute('href', items[0]?.url);
    expect(first).toHaveTextContent('News Example');
    expect(first).toHaveTextContent('Summary 1');
    // an already rated item shows its verdict instead of buttons
    const second = screen.getByTestId(`digest-item-${items[1]?.id}`);
    expect(within(second).getByTestId('verdict')).toHaveTextContent('Boring');
    expect(within(second).getByTestId('verdict')).toHaveTextContent('Seen it');
    expect(within(second).queryByRole('button', { name: 'Useful' })).toBeNull();

    const user = userEvent.setup();
    await user.type(within(first).getByPlaceholderText('Why? (optional)'), 'Has load data');
    await user.click(within(first).getByRole('button', { name: 'Useful' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      url: `/api/digest-items/${items[0]?.id}/rate`,
      body: { verdict: 'useful', reason: 'Has load data' },
    });
  });

  it('shows a Transcript expander on video and podcast items that loads the text, and says when there is none', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(
          JSON.stringify({
            url: 'https://video.example.test/watch/1',
            title: 'Talk',
            language: 'en',
            autoGenerated: true,
            path: 'projects/news/transcripts/2026-10-03-talk-ab12.md',
            text: 'Welcome to the talk about reloading.',
            truncated: false,
          }),
          { status: 200 },
        );
      }),
    );
    const video = digestItem(4, {
      kind: 'video',
      url: 'https://video.example.test/watch/1',
      transcript: { status: 'ok', path: 'projects/news/transcripts/2026-10-03-talk-ab12.md', chars: 36 },
    });
    const podcast = digestItem(5, { kind: 'podcast', transcript: { status: 'none' } });
    const article = digestItem(6);
    wrap(<DeskItem item={ratingItem([video, podcast, article])} />);

    const v = screen.getByTestId(`digest-item-${video.id}`);
    expect(within(v).queryByTestId('transcript-text')).toBeNull();
    await userEvent.setup().click(within(v).getByRole('button', { name: 'Transcript' }));
    expect(await within(v).findByTestId('transcript-text')).toHaveTextContent('Welcome to the talk');
    expect(within(v).getByTestId('transcript-meta')).toHaveTextContent('auto-generated captions');
    expect(urls[0]).toBe(`/api/projects/${video.projectId}/transcript?url=${encodeURIComponent(video.url)}`);

    const p = screen.getByTestId(`digest-item-${podcast.id}`);
    expect(within(p).getByTestId('transcript-none')).toHaveTextContent('No transcript available');
    expect(within(p).queryByRole('button', { name: 'Transcript' })).toBeNull();
    const a = screen.getByTestId(`digest-item-${article.id}`);
    expect(within(a).queryByTestId('transcript')).toBeNull();
    expect(within(a).queryByTestId('transcript-none')).toBeNull();
  });

  it('offers useful, irrelevant and boring, and no buttons when read only', async () => {
    const one = digestItem(3);
    const { unmount } = wrap(<DeskItem item={ratingItem([one])} />);
    for (const label of ['Useful', 'Irrelevant', 'Boring'])
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    unmount();
    wrap(<DeskItem item={ratingItem([one], { canAnswer: false })} />);
    expect(screen.queryByRole('button', { name: 'Useful' })).toBeNull();
  });

  it('a taste-rule proposal can be reworded before approving it', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const proposal = ratingItem([], {
      id: '0192f3a0-0000-7000-8000-0000000000e9',
      kind: 'approval',
      subkind: 'taste_rule',
      title: 'Add a taste rule for News?',
      body: 'Prefer reviews with data',
      digestItems: undefined,
    });
    wrap(<DeskItem item={proposal} />);
    const user = userEvent.setup();
    const box = screen.getByLabelText('Rule (editable)');
    await user.clear(box);
    await user.type(box, 'Prefer reviews with chronograph data');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({
      resolution: 'approved',
      editedBody: 'Prefer reviews with chronograph data',
    });
  });
});

describe('Schedules page', () => {
  const project: ProjectDto = {
    id: '0192f3a0-0000-7000-8000-0000000000b1',
    orgId: '0192f3a0-0000-7000-8000-0000000000f1',
    key: 'NEWS',
    name: 'News',
    domain: 'personal',
    workflowKey: 'feed',
    priorityTier: 2,
    branchPrefix: 'aom/',
    workingBranch: 'main',
    subCategories: [],
    vaultFolder: null,
    architecturalGlobs: [],
    e2eGlobs: [],
    status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
    myRole: 'owner',
  };
  const schedule: ScheduleDto = {
    id: '0192f3a0-0000-7000-8000-0000000000a1',
    projectId: project.id,
    projectKey: 'NEWS',
    projectName: 'News',
    name: 'Morning scan',
    kind: 'feed',
    cron: '0 7 * * *',
    timezone: 'Africa/Johannesburg',
    cardTemplate: { title: 'Morning scan', fields: { topic: 'reloading' } },
    enabled: true,
    nextFireAt: '2026-10-04T05:00:00.000Z',
    lastFiredAt: null,
    lastCardId: null,
    createdAt: '2026-10-01T00:00:00.000Z',
  };

  function stubApi(calls: Array<{ method: string; url: string; body: unknown }>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        if (method === 'GET') {
          if (url.startsWith('/api/schedules')) return json({ schedules: [schedule] });
          if (url.startsWith('/api/projects')) return json({ projects: [project] });
          return json({});
        }
        calls.push({ method, url, body: JSON.parse(String(init.body ?? '{}')) });
        return json(url.endsWith('/run') ? { cardId: schedule.id, ref: 'NEWS-7' } : schedule, 201);
      }),
    );
  }
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

  it('shows the description and the maximum items of a schedule, converting a legacy per-kind maximum', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    stubApi(calls);
    schedule.cardTemplate = {
      title: 'Morning scan',
      fields: { topic: 'reloading', description: 'Load data first.', maxPerKind: { article: 5, video: 3 } },
    };
    try {
      wrap(<Schedules />);
      const row = await screen.findByTestId('schedule-Morning scan');
      expect(within(row).getByTestId('schedule-description')).toHaveTextContent('Load data first.');
      expect(within(row).getByTestId('schedule-max-items')).toHaveTextContent('8');
    } finally {
      schedule.cardTemplate = { title: 'Morning scan', fields: { topic: 'reloading' } };
    }
  });

  it('shows each schedule with its preset name, time zone and next run, and runs it now', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    stubApi(calls);
    wrap(<Schedules />);
    const row = await screen.findByTestId('schedule-Morning scan');
    expect(within(row).getByTestId('schedule-when')).toHaveTextContent('Daily at 07:00');
    expect(within(row).getByTestId('schedule-when')).toHaveTextContent('Africa/Johannesburg');
    expect(within(row).getByTestId('schedule-next')).not.toHaveTextContent('not scheduled');
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/schedules/${schedule.id}/run` });
    expect(await screen.findByTestId('run-result')).toHaveTextContent('Emitted NEWS-7');
  });

  it('creates a feed schedule from a preset with the time zone and per-kind maximum', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    stubApi(calls);
    wrap(<Schedules />);
    const form = await screen.findByRole('form', { name: 'New schedule' });
    const user = userEvent.setup();
    await user.type(within(form).getByLabelText('Name'), 'Evening scan');
    await user.selectOptions(within(form).getByLabelText('Runs'), 'Daily at 18:00');
    const tz = within(form).getByLabelText('Time zone');
    await user.clear(tz);
    await user.type(tz, 'Africa/Johannesburg');
    await user.type(within(form).getByLabelText('Topic'), 'hunting optics');
    await user.type(within(form).getByLabelText(/Preferred sites/), 'https://a.test');
    await user.type(
      within(form).getByLabelText('Description'),
      'Only long-range hunting optics, reviewed by owners.',
    );
    expect(within(form).queryByLabelText('Max videos')).toBeNull();
    expect(within(form).getByLabelText(/Max items/)).toHaveValue('10');
    await user.clear(within(form).getByLabelText(/Max items/));
    await user.type(within(form).getByLabelText(/Max items/), '7');
    await user.click(within(form).getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/schedules' });
    expect(calls[0]?.body).toEqual({
      projectId: project.id,
      name: 'Evening scan',
      cron: '0 18 * * *',
      timezone: 'Africa/Johannesburg',
      cardTemplate: {
        title: 'Evening scan',
        cardType: 'feed',
        fields: {
          topic: 'hunting optics',
          description: 'Only long-range hunting optics, reviewed by owners.',
          windowHours: 24,
          preferredSites: ['https://a.test'],
          maxItems: 7,
        },
      },
    });
  });

  it('requires a name and topic', async () => {
    stubApi([]);
    wrap(<Schedules />);
    const form = await screen.findByRole('form', { name: 'New schedule' });
    await userEvent.setup().click(within(form).getByRole('button', { name: 'Create schedule' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A name and a topic are required');
  });
});
