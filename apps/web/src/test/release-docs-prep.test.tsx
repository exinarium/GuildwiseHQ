import type { DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseDocsPrepTab } from '../components/delivery/ReleaseDocsPrepTab.tsx';
import { ReleaseDocsPrepPanel } from '../components/ReleaseDocsPrepPanel.tsx';
import { ShipReleaseItem } from '../components/ShipReleaseItem.tsx';
import { keysForEvent } from '../ws/invalidate.ts';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const calls: Array<{ method: string; url: string; body?: any }> = [];
let routes: (url: string, method: string) => Response;
beforeEach(() => {
  calls.length = 0;
  routes = () => json({});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return routes(url, method);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  );

const settings = (over: Record<string, unknown> = {}) => ({
  enabled: false,
  canEdit: true,
  steps: [
    { id: 'analyse', label: 'Analyse changes', description: 'Lists the changes.', enabled: true },
    { id: 'commit', label: 'Commit results', description: 'Commits.', enabled: true },
  ],
  ...over,
});

describe('Release prep (docs and videos) settings', () => {
  it('lists only the registered steps and saves the switch', async () => {
    routes = (_u, m) => json(m === 'PUT' ? settings({ enabled: true }) : settings());
    wrap(<ReleaseDocsPrepPanel projectId={ID(1)} />);
    const sw = await screen.findByRole('switch');
    expect(sw).not.toBeChecked();
    expect(screen.getByText('Analyse changes')).toBeInTheDocument();
    expect(screen.getByText('Commit results')).toBeInTheDocument();
    expect(screen.queryByText('Generate videos')).not.toBeInTheDocument();
    await userEvent.setup().click(sw);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        enabled: true,
        steps: { analyse: true, commit: true },
      }),
    );
  });

  it('is read-only for a member', async () => {
    routes = () => json(settings({ canEdit: false }));
    wrap(<ReleaseDocsPrepPanel projectId={ID(1)} />);
    expect(await screen.findByRole('switch')).toBeDisabled();
    expect(screen.getByTestId('release-docs-prep-readonly')).toBeInTheDocument();
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
  });

  it('reads as off and read-only, without breaking, when the response has no steps', async () => {
    routes = () => json({ project: { id: ID(1) } });
    wrap(<ReleaseDocsPrepPanel projectId={ID(1)} />);
    const sw = await screen.findByRole('switch');
    expect(sw).not.toBeChecked();
    expect(sw).toBeDisabled();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

const run = (status: string, over: Record<string, unknown> = {}) => ({
  id: ID(7),
  projectId: ID(1),
  releaseBranch: 'release/1.5.0',
  status,
  trigger: 'manual',
  retryOf: null,
  startedBy: ID(3),
  startedAt: '2026-11-04T10:00:00.000Z',
  finishedAt: status === 'running' ? null : '2026-11-04T10:02:00.000Z',
  failed: null,
  skippedBy: null,
  skippedAt: null,
  steps: ['analyse', 'commit'],
  repos: [
    {
      repoId: ID(10),
      repoName: 'GuildwiseHQ',
      branch: 'release/1.5.0',
      state: 'passed',
      baseTag: 'v1.4.0',
      headSha: 'a'.repeat(40),
      commitSha: 'b'.repeat(40),
      pushed: true,
      summary: {
        repoName: 'GuildwiseHQ',
        branch: 'release/1.5.0',
        headSha: 'a'.repeat(40),
        base: { kind: 'tag', tag: 'v1.4.0', sha: 'c'.repeat(40) },
        commitCount: 2,
        commits: [{ sha: 'd'.repeat(40), subject: 'feat: x', author: 'A', date: '2026-11-01' }],
        commitsTruncated: false,
        merges: [],
        cards: [{ key: 'GWP-12', title: null }],
        areas: [
          { area: 'apps/server', files: 1, added: 1, modified: 0, deleted: 0, paths: ['apps/server/a.ts'] },
        ],
      },
      steps: [
        {
          step: 'analyse',
          phase: '',
          state: 'passed',
          startedAt: null,
          finishedAt: null,
          error: null,
          files: [],
        },
      ],
    },
  ],
  ...over,
});

const overview = (state: string, over: Record<string, unknown> = {}, r: unknown = run(state)) => [
  {
    projectId: ID(1),
    key: 'GWP',
    name: 'Guildwise',
    enabled: true,
    releaseBranch: 'release/1.5.0',
    state,
    canAct: true,
    run: r,
    ...over,
  },
];

describe('Releases > Release prep tab', () => {
  it('shows a passed run with its change summary and commit SHA', async () => {
    routes = () => json(overview('passed'));
    wrap(<ReleaseDocsPrepTab />);
    expect(await screen.findByTestId('release-docs-prep-state')).toHaveTextContent('passed');
    expect(screen.getByTestId('prep-summary')).toHaveTextContent('2 commits since v1.4.0');
    expect(screen.getByTestId('prep-commit')).toHaveTextContent('bbbbbbb pushed to the release branch');
    expect(screen.getByRole('button', { name: 'Run release prep' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry prep' })).not.toBeInTheDocument();
  });

  it('shows the failing step, repo and error with Retry and Skip, and posts them', async () => {
    const failed = run('failed', {
      failed: { step: 'analyse', repoId: ID(10), repoName: 'guildwise-cloud', error: 'could not fetch' },
    });
    routes = (_u, m) => (m === 'GET' ? json(overview('failed', {}, failed)) : json({ runId: ID(8) }));
    wrap(<ReleaseDocsPrepTab />);
    expect(await screen.findByTestId('release-docs-prep-failed')).toHaveTextContent(
      'Failed at analyse in guildwise-cloud: could not fetch',
    );
    expect(screen.queryByRole('button', { name: 'Run release prep' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry prep' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith(`/runs/${ID(7)}/retry`))).toBe(true),
    );
  });

  it('asks before skipping, then posts the skip', async () => {
    routes = (_u, m) => (m === 'GET' ? json(overview('failed', {}, run('failed'))) : json({}));
    wrap(<ReleaseDocsPrepTab />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Skip prep for this release' }));
    expect(calls.some((c) => c.url.endsWith('/skip'))).toBe(false);
    await user.click(await screen.findByRole('button', { name: 'Skip prep' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/skip'))).toBe(true));
  });

  it('shows not run with a Run button, and running without Run', async () => {
    routes = () => json(overview('not_run', {}, null));
    const a = wrap(<ReleaseDocsPrepTab />);
    expect(await screen.findByTestId('release-docs-prep-state')).toHaveTextContent('not run');
    expect(screen.getByRole('button', { name: 'Run release prep' })).toBeInTheDocument();
    a.unmount();
    routes = () => json(overview('running', {}, run('running')));
    wrap(<ReleaseDocsPrepTab />);
    await waitFor(() => expect(screen.getByTestId('release-docs-prep-state')).toHaveTextContent('running'));
    expect(screen.queryByRole('button', { name: 'Run release prep' })).not.toBeInTheDocument();
  });

  it("titles the panel with the overview's release branch, not the project working branch", async () => {
    routes = () =>
      json(
        overview(
          'running',
          { releaseBranch: 'release/2.3.0' },
          run('running', { releaseBranch: 'release/2.3.0' }),
        ),
      );
    wrap(<ReleaseDocsPrepTab />);
    expect(await screen.findByText('Guildwise · release/2.3.0')).toBeInTheDocument();
    expect(screen.queryByText('Guildwise · main')).not.toBeInTheDocument();
  });

  it('gives a member no actions', async () => {
    routes = () => json(overview('failed', { canAct: false }, run('failed')));
    wrap(<ReleaseDocsPrepTab />);
    await screen.findByTestId('release-docs-prep-state');
    expect(
      screen.queryByRole('button', { name: /Run release prep|Retry prep|Skip prep/ }),
    ).not.toBeInTheDocument();
  });

  it('renders nothing when no project uses release prep', async () => {
    routes = () => json([]);
    const { container } = wrap(<ReleaseDocsPrepTab />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(container.querySelector('[data-testid="release-docs-prep-tab"]')).toBeNull();
  });
});

describe('Ship release item with release prep', () => {
  const view = (docsPrep?: unknown) => ({
    proposalId: ID(9),
    projectId: ID(2),
    repoId: ID(50),
    repoName: 'guildwisehq',
    state: 'proposed',
    lastTag: 'v1.3.0',
    base: '1.3.0',
    recommended: { version: '1.4.0', level: 'minor', reason: 'minor' },
    headSha: 'a'.repeat(40),
    factsAt: new Date().toISOString(),
    factsState: 'ready',
    factsMessage: null,
    ahead: 4,
    commitsTruncated: false,
    today: '2026-10-31',
    changelog: { present: true, empty: false, intro: 'S.', body: '### Added\n\n- One.' },
    notes: '',
    notesEditable: false,
    components: [],
    componentVariants: { patch: [], minor: [], major: [] },
    rules: [],
    existingTags: ['v1.3.0'],
    ...(docsPrep ? { docsPrep } : {}),
  });
  const item = (release: unknown) =>
    ({
      id: ID(1),
      kind: 'approval',
      subkind: 'ship_release',
      title: 'Ship',
      release,
    }) as unknown as DeskItemDto;

  it('looks as before when the switch is off (no docsPrep)', () => {
    wrap(<ShipReleaseItem item={item(view())} />);
    expect(screen.queryByTestId('ship-docs-prep-blocked')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve release/ })).toBeEnabled();
  });

  it('names release prep, links to it and disables Approve when blocked', () => {
    wrap(
      <ShipReleaseItem
        item={item(
          view({
            blocked: true,
            message: 'Release prep (docs and videos) has not run for release/1.5.0.',
            link: `/releases?tab=prep#release-docs-prep-${ID(2)}`,
          }),
        )}
      />,
    );
    const box = screen.getByTestId('ship-docs-prep-blocked');
    expect(box).toHaveTextContent('Release prep (docs and videos) has not run');
    expect(screen.getByRole('link', { name: 'See release prep' })).toHaveAttribute(
      'href',
      expect.stringContaining('tab=prep'),
    );
    expect(screen.getByRole('button', { name: /Approve release/ })).toBeDisabled();
  });

  it('allows Approve when the gate is open', () => {
    wrap(<ShipReleaseItem item={item(view({ blocked: false, link: '/releases?tab=prep' }))} />);
    expect(screen.queryByTestId('ship-docs-prep-blocked')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve release/ })).toBeEnabled();
  });
});

describe('live updates', () => {
  it('refetches release prep on a run event and on a settings change', () => {
    expect(
      keysForEvent({ type: 'ReleaseDocsPrepStepFinished', streamId: 'releasedocs-abc', projectId: ID(1) }),
    ).toContainEqual(['release-docs-prep']);
    expect(
      keysForEvent({ type: 'ReleaseDocsPrepSettingsSet', streamId: `project-${ID(1)}`, projectId: ID(1) }),
    ).toContainEqual(['release-docs-prep']);
  });
});

describe("Releases > Release prep tab > 'Update user guide' output", () => {
  const guideRepo = (repoName: string, output: unknown) => ({
    repoId: repoName === 'GuildwiseHQ' ? ID(10) : ID(11),
    repoName,
    branch: 'release/1.5.0',
    state: 'passed',
    baseTag: 'v1.4.0',
    headSha: 'a'.repeat(40),
    commitSha: null,
    pushed: false,
    summary: null,
    steps: [
      {
        step: 'guide',
        phase: '',
        state: 'passed',
        startedAt: null,
        finishedAt: null,
        error: null,
        files: [],
        output,
      },
    ],
  });

  it('names the sections changed and added per repository, and the repository skipped without a guide', async () => {
    const r = run('passed', {
      steps: ['analyse', 'guide', 'commit'],
      repos: [
        guideRepo('GuildwiseHQ', {
          status: 'passed',
          changed: [{ section: '4.28 Releases', sources: ['card:GWP-89'] }],
          added: [{ section: '4.28a Release prep', after: '4.28 Releases', sources: ['card:GWP-89'] }],
          covered: [],
          skippedChanges: [{ source: 'card:GWP-12', reason: 'tests only' }],
          duplicates: 0,
          pdf: 'rebuilt',
          errors: [],
          warnings: [],
          notes: [],
        }),
        guideRepo('guildwise-cloud', {
          status: 'passed',
          skipped: 'no user guide',
          changed: [],
          added: [],
          covered: [],
          skippedChanges: [],
          errors: [],
          warnings: [],
          notes: [],
        }),
      ],
    });
    routes = () => json(overview('passed', {}, r));
    wrap(<ReleaseDocsPrepTab />);
    const hq = await screen.findByTestId('prep-repo-GuildwiseHQ');
    expect(within(hq).getByTestId('guide-output-changed')).toHaveTextContent('4.28 Releases');
    expect(within(hq).getByTestId('guide-output-added')).toHaveTextContent(
      '4.28a Release prep (after 4.28 Releases)',
    );
    expect(within(hq).getByText('PDF guide rebuilt.')).toBeInTheDocument();
    expect(within(hq).getByText('1 change is not user-visible.')).toBeInTheDocument();
    const cloud = screen.getByTestId('prep-repo-guildwise-cloud');
    expect(within(cloud).getByTestId('guide-output-skipped')).toHaveTextContent('skipped: no user guide');
  });

  it('says when no guide change was needed and ignores an output it cannot read', async () => {
    const r = run('passed', {
      steps: ['analyse', 'guide', 'commit'],
      repos: [
        guideRepo('GuildwiseHQ', {
          status: 'passed',
          nothing: 'no new changes',
          changed: [],
          added: [],
          covered: [],
          skippedChanges: [],
          errors: [],
          warnings: [],
          notes: [],
        }),
        guideRepo('guildwise-cloud', { something: 'else' }),
      ],
    });
    routes = () => json(overview('passed', {}, r));
    wrap(<ReleaseDocsPrepTab />);
    expect(await screen.findByText('No guide change: no new changes.')).toBeInTheDocument();
    expect(within(screen.getByTestId('prep-repo-guildwise-cloud')).queryByTestId('guide-output')).toBeNull();
  });
});
