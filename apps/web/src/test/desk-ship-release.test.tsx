import type { DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShipReleaseItem } from '../components/ShipReleaseItem.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const calls: Array<{ method: string; url: string; body?: any }> = [];
let reply: () => Response = () => json({});
beforeEach(() => {
  calls.length = 0;
  reply = () => json({});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return reply();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const bump = (level: 'patch' | 'minor' | 'major', to: string) => ({
  name: 'runner',
  level,
  state: 'bump' as const,
  from: '0.1.62',
  to,
  changedCount: 17,
  under: 'apps/runner/',
  versionFile: 'apps/runner/src/version.ts',
});

const view = (over: Record<string, unknown> = {}) => ({
  proposalId: ID(9),
  projectId: ID(2),
  repoId: ID(50),
  repoName: 'guildwisehq',
  state: 'proposed',
  lastTag: 'v1.3.0',
  base: '1.3.0',
  recommended: { version: '1.4.0', level: 'minor', reason: 'minor: 3 Added entries, no breaking changes' },
  headSha: 'a'.repeat(40),
  factsAt: new Date().toISOString(),
  factsState: 'ready',
  factsMessage: null,
  ahead: 4,
  commitsTruncated: false,
  today: '2026-10-31',
  changelog: {
    present: true,
    empty: false,
    intro: 'Summary.',
    body: '### Added\n\n- One.\n- Two.\n- Three.',
  },
  notes: 'Runner 0.1.63.\n\n### Added\n\n- One.',
  notesEditable: false,
  components: [bump('patch', '0.1.63')],
  componentVariants: {
    patch: [bump('patch', '0.1.63')],
    minor: [bump('minor', '0.2.0')],
    major: [bump('major', '1.0.0')],
  },
  rules: [{ name: 'runner', paths: ['apps/runner/**'], versionFile: 'apps/runner/src/version.ts' }],
  existingTags: ['v1.3.0'],
  ...over,
});

const item = (release: unknown): DeskItemDto =>
  ({
    id: ID(1),
    kind: 'approval',
    subkind: 'ship_release',
    title: 'Ship release: guildwisehq',
    release,
  }) as unknown as DeskItemDto;

const wrap = (el: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
};
const posts = () => calls.filter((c) => c.method === 'POST');

describe('Ship release desk item', () => {
  it('shows the recommendation, reason, preview and component bump', () => {
    wrap(<ShipReleaseItem item={item(view())} />);
    expect(screen.getByTestId('ship-version')).toHaveValue('1.4.0');
    expect(screen.getByTestId('ship-reason')).toHaveTextContent(
      'minor: 3 Added entries, no breaking changes',
    );
    const preview = screen.getByTestId('ship-preview');
    expect(preview).toHaveTextContent('## [1.4.0] - 2026-10-31');
    expect(preview).toHaveTextContent('Runner 0.1.63. Summary.');
    expect(preview).toHaveTextContent('- One.');
    expect(screen.getByTestId('ship-components')).toHaveTextContent(
      'runner 0.1.62 -> 0.1.63 (17 files changed under apps/runner/)',
    );
    expect(screen.getByText(/Nothing is tagged or published yet/)).toBeInTheDocument();
  });

  it('refuses a version that is equal, lower or not semver inline and disables Approve', async () => {
    const user = userEvent.setup();
    wrap(<ShipReleaseItem item={item(view())} />);
    const field = screen.getByTestId('ship-version');
    await user.clear(field);
    await user.type(field, '1.3.0');
    expect(screen.getByText('1.3.0 is not higher than the last release v1.3.0')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: /Approve release/ })).toBeDisabled();
    await user.clear(field);
    await user.type(field, 'abc');
    expect(screen.getByText(/abc is not a semantic version/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve release/ })).toBeDisabled();
    await user.clear(field);
    await user.type(field, '1.5.0');
    expect(screen.getByRole('button', { name: /Approve release 1.5.0/ })).toBeEnabled();
    expect(screen.getByTestId('ship-preview')).toHaveTextContent('## [1.5.0] - 2026-10-31');
  });

  it('raising the runner to minor updates the row and the preview', async () => {
    const user = userEvent.setup();
    wrap(<ShipReleaseItem item={item(view())} />);
    await user.selectOptions(screen.getByLabelText('runner bump level'), 'minor');
    expect(screen.getByTestId('ship-components')).toHaveTextContent('runner 0.1.62 -> 0.2.0');
    expect(screen.getByTestId('ship-preview')).toHaveTextContent('Runner 0.2.0.');
  });

  it('shows an unchanged runner without a level select', () => {
    const same = { ...bump('patch', '0.1.63'), state: 'unchanged', from: '0.1.63', changedCount: 0 };
    wrap(
      <ShipReleaseItem
        item={item(
          view({ components: [same], componentVariants: { patch: [same], minor: [same], major: [same] } }),
        )}
      />,
    );
    expect(screen.getByTestId('ship-components')).toHaveTextContent('runner 0.1.63 (unchanged)');
    expect(screen.queryByLabelText('runner bump level')).toBeNull();
    expect(screen.getByTestId('ship-preview')).toHaveTextContent('Runner 0.1.63 (unchanged).');
  });

  it('without a CHANGELOG.md the notes are editable and prefilled from the commit titles', async () => {
    const user = userEvent.setup();
    wrap(
      <ShipReleaseItem
        item={item(
          view({
            changelog: null,
            notes: '- feat: new thing\n- fix: old thing',
            notesEditable: true,
            components: [],
            componentVariants: { patch: [], minor: [], major: [] },
          }),
        )}
      />,
    );
    const notes = screen.getByTestId('ship-notes');
    expect(notes).toHaveValue('- feat: new thing\n- fix: old thing');
    await user.clear(notes);
    await user.type(notes, '- my own note');
    expect(screen.getByTestId('ship-preview')).toHaveTextContent('- my own note');
    await user.click(screen.getByRole('button', { name: /Approve release 1.4.0/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body.release.notes).toBe('- my own note');
  });

  it('approve posts the version, levels and head sha', async () => {
    const user = userEvent.setup();
    wrap(<ShipReleaseItem item={item(view())} />);
    await user.selectOptions(screen.getByLabelText('runner bump level'), 'minor');
    await user.click(screen.getByRole('button', { name: /Approve release 1.4.0/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url).toContain(`/desk/${ID(1)}/resolve`);
    expect(posts()[0]?.body).toEqual({
      resolution: 'approved',
      release: {
        version: '1.4.0',
        components: [{ name: 'runner', level: 'minor' }],
        factsHeadSha: 'a'.repeat(40),
      },
    });
  });

  it('shows a server refusal under the version field', async () => {
    const user = userEvent.setup();
    reply = () =>
      json(
        {
          error: {
            code: 'proposal_changed',
            message: 'The working branch moved since you opened this item.',
          },
        },
        409,
      );
    wrap(<ShipReleaseItem item={item(view())} />);
    await user.click(screen.getByRole('button', { name: /Approve release 1.4.0/ }));
    const msg = await screen.findByText(/The working branch moved/);
    expect(within(msg.closest('div') as HTMLElement).getByTestId('ship-version')).toBeInTheDocument();
  });

  it('shows the workstation message when reading failed', () => {
    wrap(<ShipReleaseItem item={item(view({ factsState: 'failed', factsMessage: 'no local clone' }))} />);
    expect(screen.getByRole('alert')).toHaveTextContent('no local clone');
  });
});
