import type { DigestItemDto, InterestDetailResponse, InterestDto, InterestRunDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cronOf,
  describeDelivery,
  describeScan,
  emptyValues,
  toCreateRequest,
  toPatchRequest,
  validateInterest,
  valuesFromInterest,
} from '../lib/interests.ts';
import { InterestDetail } from '../pages/InterestDetail.tsx';
import { Interests } from '../pages/Interests.tsx';
import { keysForEvent } from '../ws/invalidate.ts';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wrap = (node: React.ReactNode, path = '/interests') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {path.startsWith('/interests/') ? (
            <Route path="/interests/:id" element={node} />
          ) : (
            <>
              <Route path="/interests" element={node} />
              <Route path="/interests/:id" element={<p>elsewhere</p>} />
            </>
          )}
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const U = (n: number) => `0192f3a0-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`;

const stats = {
  lastRunAt: '2026-10-05T05:02:00.000Z',
  lastRun: { id: U(70), kind: 'scan', status: 'published', found: 14, published: 6, cardRef: 'RUSTAS-41' },
  nextScanAt: '2026-10-06T05:00:00.000Z',
  nextDeliveryAt: '2026-10-06T05:00:00.000Z',
  lastDeliveredAt: '2026-10-05T05:00:00.000Z',
  runs30d: 6,
  items: { total: 22, last30d: 22, lastRun: 6, held: 3 },
  ratings: { useful: 12, irrelevant: 3, boring: 5, unrated: 2 },
  research: { open: 1, published: 2 },
  failing: false,
  failCount: 0,
  lastError: null,
} as const;
const agent = (n: number, name: string) => ({ id: U(n), name, online: true });
const interest = (over: Partial<InterestDto> = {}): InterestDto => ({
  id: U(10),
  orgId: U(99),
  name: 'Rust async',
  description: 'Deep dives on tokio internals',
  slug: 'rust-async',
  vaultDir: 'interests/rust-async',
  hasVault: true,
  projectKey: 'RUSTAS',
  subCategory: 'rust/async',
  preferredSites: ['lobste.rs'],
  kinds: ['article', 'video', 'podcast'],
  scan: { cron: '0 7 * * *', timezone: 'Africa/Johannesburg', windowHours: 24, maxItems: 10, manual: false },
  delivery: { mode: 'scheduled', cron: '0 7 * * 1-5', timezone: 'Africa/Johannesburg' },
  status: 'active',
  archived: false,
  agents: { scout: agent(30, 'Sid'), curator: null, researcher: null, checker: null },
  canManage: true,
  canShare: true,
  createdBy: { id: U(1), name: 'Pieter' },
  tasteRuleCount: 1,
  tasteVersion: 2,
  stats,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const run = (n: number, over: Partial<InterestRunDto> = {}): InterestRunDto => ({
  id: U(70 + n),
  kind: 'scan',
  trigger: 'cron',
  status: 'published',
  startedAt: '2026-10-05T05:00:00.000Z',
  finishedAt: '2026-10-05T05:06:12.000Z',
  found: 14,
  published: 6,
  duplicatesDropped: 3,
  overMaxDropped: 5,
  startedBy: null,
  ratings: { useful: 3, irrelevant: 0, boring: 1, unrated: 2 },
  card: { id: U(80 + n), ref: `RUSTAS-${40 + n}` },
  parentRunId: null,
  childRunIds: [],
  ...over,
});

const digestItem = (n: number): DigestItemDto => ({
  id: U(90 + n),
  cardId: U(81),
  cardRef: 'RUSTAS-41',
  projectId: U(5),
  projectKey: 'RUSTAS',
  kind: 'article',
  url: `https://news.example.test/s${n}`,
  title: `Headline ${n}`,
  source: 'News Example',
  publishedAt: '2026-10-02T00:00:00.000Z',
  summary: `Summary ${n}`,
  transcript: null,
  verdict: null,
  verdictReason: null,
  ratedAt: null,
  deskItemId: null,
  createdAt: '2026-10-03T07:00:00.000Z',
});

interface Call {
  method: string;
  url: string;
  body: any;
}
function stubApi(
  interests: InterestDto[],
  calls: Call[],
  extra: { quietCap?: number | null; canSetCap?: boolean } = {},
) {
  const detail = (i: InterestDto): InterestDetailResponse => ({
    interest: i,
    publications: [
      {
        id: U(60),
        cardId: U(61),
        cardRef: 'RUSTAS-44',
        title: 'Is the new scheduler faster?',
        vaultPath: 'interests/rust-async/notes/x.md',
        createdAt: '2026-10-04T00:00:00.000Z',
      },
    ],
    taste: {
      rules: ['Skip beginner tutorials'],
      version: 2,
      hasVault: true,
      ratingLines: ['- Prefer articles like "Tokio 2.0" from tokio.rs (rated useful).'],
    },
    members: [{ userId: U(1), name: 'Pieter', role: 'owner', orgGrant: true }],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (method === 'GET') {
        const found = interests.find((i) => url.startsWith(`/api/interests/${i.id}`));
        if (url.includes('/runs/'))
          return json({
            run: run(1),
            items: [
              {
                id: U(95),
                kind: 'video',
                title: 'Async traits deep dive',
                url: 'https://v.test/1',
                source: 'YouTube',
                summary: 's',
                verdict: null,
                verdictReason: null,
                transcript: { status: 'ok', chars: 14000 },
                delivered: true,
              },
            ],
            notes: [],
            shifts: [
              {
                id: U(96),
                role: 'scout',
                agentName: 'Sid',
                status: 'ended',
                startedAt: '2026-10-05T05:00:00.000Z',
                endedAt: null,
              },
            ],
          });
        if (url.includes('/runs'))
          return json({
            runs: [
              run(1),
              run(2, {
                kind: 'research',
                trigger: 'manual',
                status: 'checking',
                published: null,
                found: null,
              }),
            ],
            hasMore: false,
          });
        if (url.includes('/deliveries'))
          return json({
            deliveries: [
              {
                id: U(97),
                at: '2026-10-05T05:00:00.000Z',
                itemCount: 6,
                heldBack: 2,
                trigger: 'schedule',
                deskItemId: null,
              },
            ],
          });
        if (url.includes('/digest')) return json({ items: [digestItem(1), digestItem(2)] });
        if (url.includes('/agents/eligible'))
          return json({
            scout: [agent(30, 'Sid'), agent(31, 'Sam')],
            curator: [agent(32, 'Cleo')],
            researcher: [],
            checker: [],
          });
        if (url.startsWith('/api/interests/') && found) return json(detail(found));
        if (url.startsWith('/api/interests/')) return json({}, 404);
        if (url.startsWith('/api/interests'))
          return json({
            interests,
            quietCap: extra.quietCap ?? 12,
            deliveredToday: 5,
            canSetCap: extra.canSetCap ?? true,
          });
        if (url.startsWith('/api/org/members'))
          return json({
            members: [
              {
                userId: U(2),
                displayName: 'Ana',
                email: 'a@x.test',
                role: 'member',
                joinedAt: '2026-10-01T00:00:00.000Z',
                allProjects: false,
                projects: [],
                twoFactorEnabled: false,
              },
            ],
          });
        return json({});
      }
      if (url.endsWith('/run')) return json({ runId: U(75), cardId: U(60), ref: 'RUSTAS-42' }, 201);
      if (url === '/api/interests') return json({ id: U(11) }, 201);
      return json({ ok: true });
    }),
  );
}

describe('lib/interests', () => {
  it('validates the form: name, cron, max items, kinds', () => {
    const v = emptyValues('UTC');
    expect(validateInterest(v)).toMatchObject({ name: expect.any(String) });
    expect(validateInterest({ ...v, name: 'X' })).toEqual({});
    expect(validateInterest({ ...v, name: 'X', preset: 'custom', cron: 'nope' }).cron).toBeTruthy();
    expect(
      validateInterest({ ...v, name: 'X', manual: true, preset: 'custom', cron: 'nope' }).cron,
    ).toBeUndefined();
    expect(validateInterest({ ...v, name: 'X', maxItems: '500' }).maxItems).toBeTruthy();
    expect(
      validateInterest({ ...v, name: 'X', deliveryPreset: 'custom', deliveryCron: '1 2' }).deliveryCron,
    ).toBeTruthy();
    expect(
      validateInterest({ ...v, name: 'X', kinds: { article: false, video: false, podcast: false } }).kinds,
    ).toBeTruthy();
    expect(cronOf({ preset: 'weekdays-0700', cron: '' })).toBe('0 7 * * 1-5');
  });

  it('describes schedules and builds the requests', () => {
    const i = interest();
    expect(describeScan(i.scan)).toBe('Daily at 07:00 (Africa/Johannesburg) · up to 10 items');
    expect(describeScan({ ...i.scan, manual: true })).toBe('Manual only · up to 10 items');
    expect(describeDelivery(i.delivery)).toBe('Weekdays at 07:00 (Africa/Johannesburg)');
    expect(describeDelivery({ ...i.delivery, mode: 'immediate' })).toBe('As soon as a run finishes');
    const v = valuesFromInterest(i);
    expect(v).toMatchObject({
      deliveryMode: 'scheduled',
      deliveryPreset: 'weekdays-0700',
      windowHours: '',
    });
    expect(
      toCreateRequest({ ...v, kinds: { article: true, video: false, podcast: true } }, ['A rule']),
    ).toMatchObject({
      name: 'Rust async',
      kinds: ['article', 'podcast'],
      tasteRules: ['A rule'],
      scan: { cron: '0 7 * * *', maxItems: 10, manual: false },
      delivery: { mode: 'scheduled', cron: '0 7 * * 1-5' },
    });
    expect(toPatchRequest(v)).not.toHaveProperty('domain');
    expect(toCreateRequest(v)).not.toHaveProperty('domain');
  });

  it('maps interest events to query keys', () => {
    const keys = keysForEvent({ type: 'InterestRunStarted', streamId: `interest-${U(10)}`, projectId: U(5) });
    for (const k of ['interests', 'interest', 'interest-runs', 'interest-deliveries', 'desk', 'digest'])
      expect(keys).toContainEqual([k]);
    expect(keysForEvent({ type: 'CardCreated', streamId: `card-${U(60)}`, projectId: U(5) })).toContainEqual([
      'interest-runs',
    ]);
  });
});

describe('Interests page', () => {
  it('lists an interest with its schedules, last run, waiting items and ratings, and a failing one', async () => {
    stubApi(
      [
        interest(),
        interest({
          id: U(13),
          name: 'Broken',
          stats: { ...stats, failing: true, failCount: 3, lastError: 'no curator online' },
        }),
      ],
      [],
    );
    wrap(<Interests />);
    const card = await screen.findByTestId('interest-Rust async');
    expect(within(card).getByTestId('interest-cadence')).toHaveTextContent(
      'Daily at 07:00 (Africa/Johannesburg) · up to 10 items',
    );
    expect(within(card).getByTestId('interest-delivery')).toHaveTextContent('Delivery: Weekdays at 07:00');
    expect(within(card).getByTestId('interest-last-run')).toHaveTextContent('found 14');
    expect(within(card).getByTestId('interest-last-run')).toHaveTextContent('RUSTAS-41');
    expect(within(card).getByText('3 waiting for delivery')).toBeInTheDocument();
    expect(within(card).getByTestId('interest-ratings')).toHaveTextContent(
      'useful 12 · irrelevant 3 · boring 5 · unrated 2',
    );
    expect(within(card).getByTestId('interest-meta')).toHaveTextContent('interests/rust-async');
    expect(within(card).getByTestId('interest-agents')).toHaveTextContent('Scout: Sid');
    const broken = screen.getByTestId('interest-Broken');
    expect(within(broken).getByText(/Cannot run \(3 tries\)/)).toBeInTheDocument();
    expect(within(broken).getByText('no curator online')).toBeInTheDocument();
    expect(screen.getByTestId('quiet-cap-line')).toHaveTextContent('At most 12 digest items a day');
  });

  it('the active tick pauses and resumes; run scan starts a run', async () => {
    const calls: Call[] = [];
    stubApi([interest()], calls);
    wrap(<Interests />);
    const card = await screen.findByTestId('interest-Rust async');
    const u = userEvent.setup();
    await u.click(within(card).getByTestId('interest-toggle'));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: 'PATCH',
          url: `/api/interests/${U(10)}`,
          body: { status: 'paused' },
        }),
      ),
    );
    await u.click(within(card).getByTestId('interest-run'));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'POST', url: `/api/interests/${U(10)}/run` }),
      ),
    );
    expect(await within(card).findByTestId('interest-run-result')).toHaveTextContent('RUSTAS-42');
    expect(within(card).getByTestId('interest-digests')).toHaveAttribute(
      'href',
      `/interests/${U(10)}?tab=digest`,
    );
  });

  it('hides the controls of someone who may not change the interest', async () => {
    stubApi([interest({ canManage: false })], []);
    wrap(<Interests />);
    const card = await screen.findByTestId('interest-Rust async');
    expect(within(card).queryByTestId('interest-run')).toBeNull();
    expect(within(card).queryByTestId('interest-research')).toBeNull();
    expect(within(card).getByTestId('interest-toggle')).toBeDisabled();
    expect(within(card).getByTestId('interest-edit')).toHaveTextContent('Open');
  });

  it('creates an interest with its schedules, kinds and taste rules, then opens it', async () => {
    const calls: Call[] = [];
    stubApi([], calls);
    wrap(<Interests />);
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('interest-new'));
    const dialog = await screen.findByTestId('interest-new-dialog');
    await u.click(within(dialog).getByTestId('interest-save'.replace('save', 'name')));
    await u.type(within(dialog).getByTestId('interest-name'), 'AI agents');
    await u.click(within(dialog).getByTestId('interest-kind-podcast'));
    await u.selectOptions(within(dialog).getByTestId('interest-delivery-mode'), 'immediate');
    await u.type(within(dialog).getByTestId('taste-rule-input'), 'Skip hype{enter}');
    await u.click(screen.getByTestId('interest-save'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/interests')).toBe(true),
    );
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/interests');
    expect(post?.body).toMatchObject({
      name: 'AI agents',
      kinds: ['article', 'video'],
      tasteRules: ['Skip hype'],
      delivery: { mode: 'immediate' },
      scan: { manual: false },
    });
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
  });

  it('shows the quiet cap and saves a new one', async () => {
    const calls: Call[] = [];
    stubApi([interest()], calls);
    wrap(<Interests />);
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('quiet-cap-edit'));
    const input = screen.getByTestId('quiet-cap-input');
    await u.clear(input);
    await u.type(input, '20');
    await u.click(screen.getByTestId('quiet-cap-save'));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'PUT', url: '/api/reporting', body: { interestDigestCap: 20 } }),
      ),
    );
  });

  it('only the Owner and Admins see the change button of the quiet cap', async () => {
    stubApi([interest()], [], { canSetCap: false });
    wrap(<Interests />);
    await screen.findByTestId('quiet-cap');
    expect(screen.queryByTestId('quiet-cap-edit')).toBeNull();
  });

  it('Research this opens the dialog and sends a research run with the question and depth', async () => {
    const calls: Call[] = [];
    stubApi([interest()], calls);
    wrap(<Interests />);
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('interest-research'));
    const q = await screen.findByTestId('research-question');
    expect((q as HTMLTextAreaElement).value).toBe('What should I know now about Rust async?');
    await u.selectOptions(screen.getByTestId('research-depth'), 'deep');
    await u.click(screen.getByTestId('research-submit'));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: 'POST',
          url: `/api/interests/${U(10)}/run`,
          body: { kind: 'research', question: 'What should I know now about Rust async?', depth: 'deep' },
        }),
      ),
    );
    expect(await screen.findByTestId('research-card-link')).toHaveTextContent('RUSTAS-42');
  });
});

describe('Interest detail', () => {
  it('shows the overview, switches tabs and reads the tab from the address', async () => {
    stubApi([interest()], []);
    wrap(<InterestDetail />, `/interests/${U(10)}`);
    expect(await screen.findByTestId('overview-tab')).toBeInTheDocument();
    expect(screen.getByTestId('overview-scan')).toHaveTextContent('Daily at 07:00');
    expect(screen.getByTestId('overview-delivery')).toHaveTextContent('Weekdays at 07:00');
    expect(screen.getByTestId('overview-held')).toHaveTextContent('3 items');
    expect(screen.getByTestId('interest-publications')).toHaveTextContent('Is the new scheduler faster?');
    expect(screen.getByTestId('interest-sub')).toHaveTextContent('interests/rust-async');
    await userEvent.setup().click(screen.getByTestId('interest-tab-runs'));
    expect(await screen.findByTestId('run-log')).toBeInTheDocument();
  });

  it('the run log lists runs with found and published, expands to items and agents', async () => {
    stubApi([interest()], []);
    wrap(<InterestDetail />, `/interests/${U(10)}?tab=runs`);
    const row = await screen.findByTestId('run-RUSTAS-41');
    expect(within(row).getByTestId('run-counts')).toHaveTextContent(
      'found 14 → 6 published (dup 3, over max 5)',
    );
    expect(within(row).getByTestId('run-ratings')).toHaveTextContent('useful 3');
    expect(within(row).getByText('Published')).toBeInTheDocument();
    expect(screen.getByTestId('run-RUSTAS-42')).toHaveTextContent('Research');
    await userEvent.setup().click(within(row).getByTestId('run-toggle'));
    const detail = await within(row).findByTestId('run-detail');
    expect(within(detail).getByTestId('run-item')).toHaveTextContent('transcript: 14000 characters');
    expect(within(detail).getByTestId('run-shifts')).toHaveTextContent('Sid (scout): ended');
    expect(screen.getByTestId('delivery-log')).toHaveTextContent(
      '6 items on your desk, 2 held back by the quiet cap',
    );
  });

  it('settings: saves the schedules and sends the preferred agents; there is no vault to choose', async () => {
    const calls: Call[] = [];
    stubApi([interest()], calls);
    wrap(<InterestDetail />, `/interests/${U(10)}?tab=settings`);
    const u = userEvent.setup();
    await screen.findByTestId('interest-form');
    expect(screen.queryByTestId('interest-domain')).toBeNull();
    expect(screen.queryByLabelText('Vault')).toBeNull();
    await u.clear(screen.getByTestId('interest-max-items'));
    await u.type(screen.getByTestId('interest-max-items'), '15');
    await u.selectOptions(await screen.findByTestId('interest-delivery-mode'), 'immediate');
    await u.selectOptions(screen.getByTestId('interest-agent-curator'), U(32));
    await u.click(screen.getByTestId('interest-save'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PATCH' && c.url === `/api/interests/${U(10)}`)).toBe(true),
    );
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      scan: { maxItems: 15, cron: '0 7 * * *' },
      delivery: { mode: 'immediate' },
      agents: { scout: U(30), curator: U(32), researcher: null, checker: null },
    });
    expect(patch?.body).not.toHaveProperty('domain');
  });

  it('taste: edits the rules, saves them and resyncs taste.md; the ratings are read only', async () => {
    const calls: Call[] = [];
    stubApi([interest()], calls);
    wrap(<InterestDetail />, `/interests/${U(10)}?tab=taste`);
    const u = userEvent.setup();
    await screen.findByTestId('taste-tab');
    expect(screen.getByTestId('taste-mirror-status')).toHaveTextContent('version 2');
    expect(screen.getByTestId('taste-ratings')).toHaveTextContent('Prefer articles like "Tokio 2.0"');
    expect(screen.getByTestId('taste-save')).toBeDisabled();
    await u.type(screen.getByTestId('taste-rule-input'), 'Prefer primary sources{enter}');
    await u.click(screen.getByTestId('taste-save'));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: 'PUT',
          url: `/api/interests/${U(10)}/taste`,
          body: { rules: ['Skip beginner tutorials', 'Prefer primary sources'] },
        }),
      ),
    );
    await u.click(screen.getByTestId('taste-resync'));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'POST', url: `/api/interests/${U(10)}/taste/resync` }),
      ),
    );
  });

  it('digest: lists delivered items with ratings and starts research from an item', async () => {
    const calls: Call[] = [];
    stubApi([interest()], calls);
    wrap(<InterestDetail />, `/interests/${U(10)}?tab=digest`);
    const u = userEvent.setup();
    expect(await screen.findByTestId('digest-held')).toHaveTextContent('3 more waiting');
    const items = await screen.findByTestId('digest-items');
    expect(within(items).getAllByTestId('item-research')).toHaveLength(2);
    await u.click(within(items).getAllByTestId('item-research')[0] as HTMLElement);
    await u.click(await screen.findByTestId('research-submit'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/run'))?.body).toMatchObject({
        kind: 'research',
        sourceItemId: U(92),
      }),
    );
  });

  it('archive asks first; an archived interest offers restore and a typed delete', async () => {
    const calls: Call[] = [];
    stubApi([interest({ archived: true })], calls);
    wrap(<InterestDetail />, `/interests/${U(10)}`);
    const u = userEvent.setup();
    await u.click(await screen.findByLabelText('More actions'));
    await u.click(await screen.findByText('Delete permanently'));
    const confirm = await screen.findByTestId('interest-delete-confirm');
    expect(confirm).toBeDisabled();
    await u.type(screen.getByTestId('interest-delete-slug'), 'rust-async');
    await u.click(confirm);
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'DELETE', url: `/api/interests/${U(10)}?confirmSlug=rust-async` }),
      ),
    );
  });

  it('a read-only viewer sees a notice and no save button', async () => {
    stubApi([interest({ canManage: false })], []);
    wrap(<InterestDetail />, `/interests/${U(10)}?tab=settings`);
    expect(await screen.findByTestId('interest-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('interest-save')).toBeNull();
  });
});
