/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PackDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillPicker } from '../components/capabilities/SkillPicker.tsx';
import { NewDiscoveryDialog } from '../components/discovery/NewDiscoveryDialog.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { Capabilities } from '../pages/Capabilities.tsx';

const PACK = '0192f3a0-0000-7000-8000-0000000000c1';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA2 = '9999999999999999999999999999999999999999';
const HASH = 'f'.repeat(64);
const H = '0'.repeat(64);
const AT = '2026-10-20T10:00:00.000Z';

const pack = (over: Partial<PackDto> = {}): PackDto => ({
  id: PACK,
  name: 'bmad',
  url: 'https://github.com/bmad-code-org/BMAD-METHOD.git',
  ref: 'v6.12.4',
  adapter: 'bmad',
  scope: 'org',
  projectId: null,
  preset: 'bmad',
  status: 'ready',
  error: null,
  pinnedSha: SHA,
  contentHash: HASH,
  trusted: false,
  trustedSha: null,
  scriptsEnabled: false,
  hasScripts: true,
  license: 'MIT',
  integrityFailed: false,
  itemCount: 2,
  workstationIds: [],
  update: null,
  lastCheckedAt: null,
  addedAt: AT,
  attribution: 'BMad Method, by BMad Code, LLC. MIT licence.',
  ...over,
});

const item = (over: Record<string, unknown>) => ({
  kind: 'skill',
  key: 'git',
  name: 'Git',
  description: 'Use git',
  hash: H,
  source: 'builtin',
  overrides: false,
  usable: true,
  ...over,
});

const snapshot = {
  ref: 'v6.12.4',
  sha: SHA,
  contentHash: HASH,
  adapter: 'bmad',
  license: 'MIT',
  hasScripts: true,
  issues: [{ path: 'broken/SKILL.md', message: 'missing frontmatter' }],
  notes: ['bmad-party-mode: not imported, the Boardroom replaces it'],
  items: [
    {
      kind: 'persona',
      key: 'bmad:analyst',
      name: 'Mary, Analyst',
      description: 'Digs into the problem',
      hash: H,
      source: 'pack',
      pack: 'bmad',
      icon: 'M',
      files: [{ path: 'agents/analyst.md', size: 100, script: false, hash: 'aaaaaaaaaaaa' }],
    },
    {
      kind: 'skill',
      key: 'bmad:create-epics',
      name: 'Create epics',
      description: 'Epics and stories',
      hash: H,
      source: 'pack',
      pack: 'bmad',
      hasScripts: true,
      files: [
        { path: 'create-epics/SKILL.md', size: 3000, script: false, hash: 'bbbbbbbbbbbb' },
        { path: 'create-epics/scripts/run.sh', size: 50, script: true, hash: 'cccccccccccc' },
      ],
    },
  ],
};

type Handler = (init: RequestInit) => unknown;
function stub(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const key = Object.keys(handlers)
        .filter((k) => `${method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (method === 'DELETE') return new Response(null, { status: 204 });
      const body = key ? (handlers[key] as Handler)(init) : {};
      return new Response(JSON.stringify(body), { status: method === 'POST' ? 201 : 200 });
    }),
  );
  return calls;
}
const me = {
  'GET /api/auth/me': () => ({
    user: { id: 'u', email: 'o@example.com', displayName: 'Owner' },
    activeOrg: { id: 'o', name: 'Org', role: 'owner' },
  }),
};
const wrap = (ui: ReactNode, path = '/settings/capabilities') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
const packsTab = () => wrap(<Capabilities />, '/settings/capabilities?tab=packs');
const packsHandlers = (p: PackDto, extra: Record<string, Handler> = {}) => ({
  ...me,
  'GET /api/projects': () => ({ projects: [] }),
  'GET /api/packs/': () => ({ pack: { ...p, snapshot, updateSnapshot: null } }),
  'GET /api/packs': () => ({ packs: [p], workstationsOnline: 1 }),
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe('Capabilities: registry browser', () => {
  const items = [
    item({}),
    item({ kind: 'persona', key: 'security', name: 'Security', source: 'org-vault', overrides: true }),
    item({
      key: 'bmad:create-epics',
      name: 'Create epics',
      source: 'pack',
      pack: 'bmad',
      usable: false,
      unusableReason: 'untrusted',
      hasScripts: true,
    }),
    item({
      key: 'bmad:other',
      name: 'Other',
      source: 'pack',
      pack: 'bmad',
      usable: false,
      unusableReason: 'integrity',
    }),
  ];
  it('shows source, override, approval, files-changed and scripts badges, issues, and filters by kind and source', async () => {
    const user = userEvent.setup();
    stub({
      ...me,
      'GET /api/projects': () => ({ projects: [] }),
      'GET /api/capabilities': () => ({
        items,
        issues: [{ path: 'skills/bad/SKILL.md', message: 'no description' }],
        indexedAt: null,
      }),
    });
    wrap(<Capabilities />);
    const row = await screen.findByTestId('cap-skill-bmad:create-epics');
    expect(row).toHaveTextContent('pack: bmad');
    expect(row).toHaveTextContent('needs approval');
    expect(row).toHaveTextContent('has scripts');
    expect(screen.getByTestId('cap-skill-bmad:other')).toHaveTextContent('files changed');
    expect(screen.getByTestId('cap-persona-security')).toHaveTextContent('organization vault');
    expect(screen.getByTestId('cap-persona-security')).toHaveTextContent('overrides');
    expect(screen.getByTestId('cap-skill-git')).toHaveTextContent('built-in');
    expect(screen.getByTestId('registry-issues')).toHaveTextContent('skills/bad/SKILL.md');

    await user.selectOptions(screen.getByLabelText('Kind'), 'persona');
    expect(screen.queryByTestId('cap-skill-git')).not.toBeInTheDocument();
    expect(screen.getByTestId('cap-persona-security')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Kind'), '');
    await user.selectOptions(screen.getByLabelText('Source'), 'pack');
    expect(screen.queryByTestId('cap-skill-git')).not.toBeInTheDocument();
    expect(screen.getByTestId('cap-skill-bmad:other')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search'), 'epics');
    expect(screen.queryByTestId('cap-skill-bmad:other')).not.toBeInTheDocument();
  });

  it('tells a member that only Owners and Admins manage capabilities', async () => {
    stub({
      'GET /api/auth/me': () => ({
        user: { id: 'u', email: 'm@example.com', displayName: 'M' },
        activeOrg: { id: 'o', name: 'Org', role: 'member' },
      }),
    });
    wrap(<Capabilities />);
    expect(await screen.findByText('Owners and Admins only')).toBeInTheDocument();
  });
});

describe('Capabilities: packs', () => {
  it('lists a pack with status, commit, licence and attribution, and warns when no workstation is online', async () => {
    stub({
      ...me,
      'GET /api/projects': () => ({ projects: [] }),
      'GET /api/packs': () => ({ packs: [pack({ preset: null })], workstationsOnline: 0 }),
    });
    packsTab();
    const card = await screen.findByTestId('pack-bmad');
    expect(card).toHaveTextContent('untrusted');
    expect(card).toHaveTextContent('a1b2c3d');
    expect(card).toHaveTextContent('v6.12.4');
    expect(card).toHaveTextContent('licence MIT');
    expect(card).toHaveTextContent('BMad Method, by BMad Code, LLC');
    expect(screen.getByTestId('no-workstation')).toHaveTextContent('No workstation is online');
    expect(screen.queryByLabelText('Allow this pack', { exact: false })).not.toBeInTheDocument();
  });

  it('adds a pack by URL and ref for a project', async () => {
    const user = userEvent.setup();
    const calls = stub({
      ...me,
      'GET /api/projects': () => ({
        projects: [{ id: '0192f3a0-0000-7000-8000-0000000000a1', key: 'TOY', name: 'Toy', myRole: 'owner' }],
      }),
      'GET /api/packs': () => ({ packs: [], workstationsOnline: 1 }),
      'POST /api/packs': () => ({ pack: pack() }),
    });
    packsTab();
    await user.click(await screen.findByRole('button', { name: 'Add a pack by git URL' }));
    await user.type(screen.getByLabelText('Git URL'), 'https://github.com/acme/skills.git');
    await user.type(screen.getByLabelText('Tag, branch or commit'), 'v1.0.0');
    await user.selectOptions(screen.getByLabelText('Available to'), 'project');
    expect(screen.getByRole('button', { name: 'Add pack' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Project'), '0192f3a0-0000-7000-8000-0000000000a1');
    await user.click(screen.getByRole('button', { name: 'Add pack' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url === '/api/packs')?.body).toEqual({
        url: 'https://github.com/acme/skills.git',
        ref: 'v1.0.0',
        adapter: 'auto',
        scope: 'project',
        projectId: '0192f3a0-0000-7000-8000-0000000000a1',
      }),
    );
  });

  it('lets the admin choose the workstations that hold a new pack, their own by default', async () => {
    const user = userEvent.setup();
    const mine = '0192f3a0-0000-7000-8000-0000000000b1';
    const theirs = '0192f3a0-0000-7000-8000-0000000000b2';
    const calls = stub({
      ...me,
      'GET /api/projects': () => ({ projects: [] }),
      'GET /api/packs': () => ({
        packs: [],
        workstationsOnline: 1,
        workstations: [
          { id: mine, name: 'Laptop', mine: true, online: true },
          { id: theirs, name: 'Desk of Sam', mine: false, online: true },
        ],
      }),
      'POST /api/packs': () => ({ pack: pack() }),
    });
    packsTab();
    await user.click(await screen.findByRole('button', { name: 'Add a pack by git URL' }));
    await user.type(screen.getByLabelText('Git URL'), 'https://github.com/acme/skills.git');
    await user.type(screen.getByLabelText('Tag, branch or commit'), 'v1.0.0');
    expect(screen.getByLabelText(/Laptop/)).toBeChecked();
    expect(screen.getByLabelText(/Desk of Sam/)).not.toBeChecked();
    // only a colleague's workstation: refused, one of the admin's own is needed to pin
    await user.click(screen.getByLabelText(/Desk of Sam/));
    await user.click(screen.getByLabelText(/Laptop/));
    expect(screen.getByRole('button', { name: 'Add pack' })).toBeDisabled();
    await user.click(screen.getByLabelText(/Laptop/));
    await user.click(screen.getByRole('button', { name: 'Add pack' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url === '/api/packs')?.body).toMatchObject({
        workstationIds: expect.arrayContaining([mine, theirs]),
      }),
    );
  });

  it('adds the BMAD preset after showing its attribution and MIT licence', async () => {
    const user = userEvent.setup();
    const calls = stub({
      ...me,
      'GET /api/projects': () => ({ projects: [] }),
      'GET /api/packs': () => ({ packs: [], workstationsOnline: 1 }),
      'POST /api/packs': () => ({ pack: pack() }),
    });
    packsTab();
    await user.click(await screen.findByTestId('preset-bmad'));
    const dlg = await screen.findByTestId('preset-dialog');
    expect(dlg).toHaveTextContent('BMad Code, LLC');
    expect(dlg).toHaveTextContent('MIT');
    expect(dlg).toHaveTextContent('stays untrusted');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add BMAD Method' }));
    await waitFor(() => {
      const body = calls.find((c) => c.method === 'POST' && c.url === '/api/packs')?.body;
      expect(body).toMatchObject({
        name: 'bmad',
        adapter: 'bmad',
        preset: 'bmad',
        scope: 'org',
        ref: expect.stringMatching(/^v/),
      });
    });
  });

  it('hides the preset button once that preset is added', async () => {
    stub(packsHandlers(pack()));
    packsTab();
    await screen.findByTestId('pack-bmad');
    expect(screen.queryByTestId('preset-bmad')).not.toBeInTheDocument();
  });

  it('review shows scripts flagged, notes and issues, and approves the exact sha and content hash', async () => {
    const user = userEvent.setup();
    const calls = stub(
      packsHandlers(pack(), { 'POST /api/packs/': () => ({ pack: pack({ trusted: true }) }) }),
    );
    packsTab();
    await user.click(await screen.findByRole('button', { name: 'Review and approve' }));
    const review = await screen.findByTestId('trust-review');
    await within(review).findByTestId('review-item-bmad:create-epics');
    expect(within(review).getByTestId('review-sha')).toHaveTextContent('a1b2c3d');
    expect(within(review).getByTestId('review-notes')).toHaveTextContent('bmad-party-mode: not imported');
    expect(within(review).getByTestId('review-issues')).toHaveTextContent('broken/SKILL.md');
    expect(within(review).getByTestId('review-has-scripts')).toBeInTheDocument();
    expect(within(review).getByText(/Scripts stay off/)).toBeInTheDocument();
    expect(within(review).getByText(/outside content/)).toBeInTheDocument();
    const scripts = within(review).getAllByTestId('file-script');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toHaveTextContent('create-epics/scripts/run.sh');
    expect(within(review).getByText('Personas (1)')).toBeInTheDocument();
    expect(within(review).getByText('Skills (1)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve this exact commit and content' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/packs/${PACK}/trust`)?.body).toEqual({
        sha: SHA,
        contentHash: HASH,
      }),
    );
  });

  it('shows the update diff with scripts highlighted and accepts the commit it showed', async () => {
    const user = userEvent.setup();
    const update = {
      sha: SHA2,
      ref: 'v6.13.0',
      foundAt: AT,
      diff: {
        addedCapabilities: [{ id: 'skill:bmad:new', name: 'New skill' }],
        removedCapabilities: [{ id: 'skill:bmad:old', name: 'Old skill' }],
        changedCapabilities: [
          {
            id: 'skill:bmad:create-epics',
            name: 'Create epics',
            addedFiles: ['scripts/extra.sh'],
            removedFiles: [],
            changedFiles: ['SKILL.md'],
          },
        ],
        scriptsAdded: ['skill:bmad:create-epics/scripts/extra.sh'],
        scriptsChanged: [],
        counts: { filesAdded: 2, filesRemoved: 1, filesChanged: 1 },
        hasChanges: true,
      },
    };
    const calls = stub(
      packsHandlers(pack({ trusted: true, update }), {
        'POST /api/packs/': () => ({ pack: pack({ trusted: true }) }),
      }),
    );
    packsTab();
    const banner = await screen.findByTestId('update-available');
    expect(banner).toHaveTextContent('v6.13.0');
    expect(banner).toHaveTextContent('script files');
    await user.click(within(banner).getByRole('button', { name: 'Review update' }));
    const diff = await screen.findByTestId('pack-diff');
    expect(diff).toHaveTextContent('New skill');
    expect(diff).toHaveTextContent('Old skill');
    expect(within(diff).getByTestId('changed-skill:bmad:create-epics')).toHaveTextContent('SKILL.md changed');
    expect(within(diff).getByTestId('diff-scripts')).toHaveTextContent('scripts/extra.sh');
    await user.click(screen.getByRole('button', { name: /Accept update/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/packs/${PACK}/accept-update`)?.body).toEqual({ sha: SHA2 }),
    );
  });

  it('checks for updates with an optional new ref', async () => {
    const user = userEvent.setup();
    const calls = stub(packsHandlers(pack({ trusted: true }), { 'POST /api/packs/': () => ({}) }));
    packsTab();
    await user.click(await screen.findByRole('button', { name: 'Check another tag…' }));
    await user.type(screen.getByLabelText('New tag, branch or commit (optional)'), 'v7.0.0');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/packs/${PACK}/check`)?.body).toEqual({ ref: 'v7.0.0' }),
    );
  });

  it('offers the scripts toggle only for a trusted pack with scripts, behind a sandbox warning', async () => {
    const user = userEvent.setup();
    const calls = stub(packsHandlers(pack({ trusted: true }), { 'POST /api/packs/': () => ({}) }));
    packsTab();
    const toggle = await screen.findByRole('checkbox', { name: "Allow this pack's scripts" });
    await user.click(toggle);
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveTextContent('only inside the sandbox');
    expect(dlg).toHaveTextContent('never for turns that talk to a model directly');
    await user.click(within(dlg).getByRole('button', { name: 'Allow scripts' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/packs/${PACK}/scripts`)?.body).toEqual({ enabled: true }),
    );
  });

  it('has no scripts toggle for an untrusted pack or a trusted pack without scripts', async () => {
    stub(packsHandlers(pack({ trusted: false })));
    const first = packsTab();
    await screen.findByTestId('pack-bmad');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    first.unmount();
    stub(packsHandlers(pack({ trusted: true, hasScripts: false })));
    packsTab();
    await screen.findByTestId('trusted');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('revokes approval and removes a pack only after confirmation', async () => {
    const user = userEvent.setup();
    const calls = stub(packsHandlers(pack({ trusted: true }), { 'POST /api/packs/': () => ({}) }));
    packsTab();
    await user.click(await screen.findByRole('button', { name: 'Revoke approval' }));
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(false);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke approval' }),
    );
    await waitFor(() => expect(calls.some((c) => c.url === `/api/packs/${PACK}/revoke`)).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove pack' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/packs/${PACK}`)).toBe(true),
    );
  });

  it('shows the integrity-failed banner', async () => {
    stub(packsHandlers(pack({ trusted: true, integrityFailed: true })));
    packsTab();
    expect(await screen.findByTestId('integrity-failed')).toHaveTextContent(
      'files on disk changed since you approved',
    );
  });

  it('shows a pending pack as waiting for a workstation and a failed one with its error', async () => {
    stub({
      ...me,
      'GET /api/projects': () => ({ projects: [] }),
      'GET /api/packs': () => ({
        packs: [
          pack({ status: 'pending', pinnedSha: null }),
          pack({
            id: '0192f3a0-0000-7000-8000-0000000000c2',
            name: 'bad',
            preset: null,
            status: 'failed',
            error: 'ref not found',
          }),
        ],
        workstationsOnline: 1,
      }),
    });
    packsTab();
    expect(await screen.findByText('waiting for a workstation')).toBeInTheDocument();
    expect(screen.getByText('ref not found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review and approve' })).not.toBeInTheDocument();
  });
});

describe('skill grants picker', () => {
  function Harness({ initial = [] as string[] }) {
    const [v, setV] = useState<string[]>(initial);
    return (
      <>
        <SkillPicker value={v} onChange={setV} />
        <output data-testid="value">{JSON.stringify(v)}</output>
      </>
    );
  }
  const capHandler = (url: string) => {
    expect(url).toContain('usable=true');
    return {
      items: [
        item({ key: 'git', name: 'Git' }),
        item({ key: 'bmad:create-epics', name: 'Create epics', source: 'pack', pack: 'bmad' }),
        item({
          key: 'bmad:untrusted',
          name: 'Hidden skill',
          source: 'pack',
          pack: 'bmad',
          usable: false,
          unusableReason: 'untrusted',
        }),
      ],
      issues: [],
      indexedAt: null,
    };
  };

  it('offers usable registry skills with source badges, never an unapproved pack skill, and stores plain keys', async () => {
    const user = userEvent.setup();
    let seen = '';
    stub({
      'GET /api/capabilities': () => {
        return capHandler(seen || '?kind=skill&usable=true');
      },
    });
    wrap(<Harness />);
    const options = await screen.findByTestId('skill-options');
    expect(options).toHaveTextContent('Git');
    expect(options).toHaveTextContent('bmad:create-epics');
    expect(within(options).getByTestId('source-pack')).toHaveTextContent('pack: bmad');
    expect(options).not.toHaveTextContent('Hidden skill');
    await user.click(screen.getByRole('button', { name: 'Add skill bmad:create-epics' }));
    expect(screen.getByTestId('value')).toHaveTextContent('["bmad:create-epics"]');
    expect(screen.getByTestId('granted-bmad:create-epics')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add skill bmad:create-epics' })).not.toBeInTheDocument();
    seen = '';
  });

  it('marks a granted pack skill that is not usable now', async () => {
    stub({ 'GET /api/capabilities': () => capHandler('?kind=skill&usable=true') });
    wrap(<Harness initial={['bmad:gone']} />);
    expect(await screen.findByTestId('granted-bmad:gone')).toHaveTextContent('not usable now');
  });

  it('renders nothing when the registry has no skills', async () => {
    stub({ 'GET /api/capabilities': () => ({ items: [], issues: [], indexedAt: null }) });
    wrap(<Harness />);
    await waitFor(() => expect(screen.queryByTestId('skill-picker')).not.toBeInTheDocument());
  });
});

describe('Discovery dialog and registry playbooks', () => {
  it('offers usable pack playbooks tagged discovery and templates, and sends their keys', async () => {
    const user = userEvent.setup();
    const calls = stub({
      ...me,
      'GET /api/projects': () => ({ projects: [] }),
      'GET /api/workstations': () => ({ workstations: [] }),
      'GET /api/ceo/status': () => ({ state: 'none' }),
      'GET /api/capabilities': () => ({
        items: [
          item({
            kind: 'playbook',
            key: 'bmad:brainstorming',
            name: 'BMAD brainstorming',
            source: 'pack',
            pack: 'bmad',
            tags: ['discovery'],
          }),
          item({
            kind: 'playbook',
            key: 'bmad:prd-template',
            name: 'BMAD PRD',
            source: 'pack',
            pack: 'bmad',
            tags: ['template:prd'],
          }),
          item({
            kind: 'playbook',
            key: 'bmad:locked',
            name: 'Locked play',
            source: 'pack',
            pack: 'bmad',
            tags: ['discovery'],
            usable: false,
            unusableReason: 'untrusted',
          }),
        ],
        issues: [],
        indexedAt: null,
      }),
      'POST /api/discovery': () => ({ threadId: 't1' }),
    });
    wrap(<NewDiscoveryDialog open onOpenChange={() => undefined} />, '/discovery');
    const start = await screen.findByLabelText('Start from');
    await screen.findByRole('option', { name: 'BMAD brainstorming (bmad)' });
    expect(screen.queryByRole('option', { name: /Locked play/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Invoicing');
    await user.selectOptions(start, 'bmad:brainstorming');
    await user.selectOptions(
      await screen.findByLabelText('Document template (optional)'),
      'bmad:prd-template',
    );
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toMatchObject({ playbook: 'bmad:brainstorming', templateKey: 'bmad:prd-template' });
    });
  });
});

describe('Capabilities: R2 project skills review and one-click update check', () => {
  const skill = (over: Record<string, unknown> = {}) => ({
    projectId: '0192f3a0-0000-7000-8000-0000000000e1',
    projectKey: 'TOY',
    projectName: 'Toy',
    kind: 'skill',
    key: 'deploy-helper',
    name: 'Deploy helper',
    description: 'Deploys things',
    hash: 'a'.repeat(64),
    repo: 'toy-app',
    path: '.claude/skills/deploy-helper',
    status: 'unreviewed',
    reviewedHash: null,
    reviewedBy: null,
    reviewedAt: null,
    indexedAt: '2026-10-03T10:00:00.000Z',
    ...over,
  });

  it('checks a pack for updates with one click on its current ref', async () => {
    const user = userEvent.setup();
    const calls = stub(packsHandlers(pack({ trusted: true }), { 'POST /api/packs/': () => ({}) }));
    packsTab();
    await user.click(await screen.findByRole('button', { name: 'Check for updates' }));
    await waitFor(() => expect(calls.find((c) => c.url === `/api/packs/${PACK}/check`)).toBeTruthy());
    expect(calls.find((c) => c.url === `/api/packs/${PACK}/check`)?.body).toEqual({});
  });

  it('lists project repository skills with repo, path, hash and status, and reviews or blocks them', async () => {
    const user = userEvent.setup();
    let items = [skill(), skill({ key: 'old', name: 'Old', status: 'changed' })];
    const calls = stub({
      ...me,
      'GET /api/capabilities/project-skills': () => ({ items }),
      'POST /api/capabilities/project-skills/review': (init) => {
        const b = JSON.parse(String(init.body));
        items = items.map((i) => (i.key === b.key ? skill({ ...i, status: b.status }) : i));
        return { items };
      },
    });
    wrap(<Capabilities />, '/settings/capabilities?tab=project-skills');
    const rows = await screen.findAllByTestId('project-skill');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('toy-app');
    expect(rows[0]).toHaveTextContent('.claude/skills/deploy-helper');
    expect(rows[0]).toHaveTextContent('aaaaaaaaaaaa');
    expect(within(rows[0] as HTMLElement).getByTestId('skill-status')).toHaveTextContent('Not reviewed');
    expect(within(rows[1] as HTMLElement).getByTestId('skill-status')).toHaveTextContent(
      'Changed since review',
    );
    await user.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/review'))?.body).toEqual({
        projectId: '0192f3a0-0000-7000-8000-0000000000e1',
        kind: 'skill',
        key: 'deploy-helper',
        hash: 'a'.repeat(64),
        status: 'reviewed',
      }),
    );
    await waitFor(() =>
      expect(
        within(screen.getAllByTestId('project-skill')[0] as HTMLElement).getByTestId('skill-status'),
      ).toHaveTextContent('Reviewed'),
    );
    await user.click(
      within(screen.getAllByTestId('project-skill')[1] as HTMLElement).getByRole('button', { name: 'Block' }),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith('/review')).map((c) => c.body.status)).toEqual([
        'reviewed',
        'blocked',
      ]),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unblock' })).toBeInTheDocument());
  });

  it('says so when no project repository carries a capability', async () => {
    stub({ ...me, 'GET /api/capabilities/project-skills': () => ({ items: [] }) });
    wrap(<Capabilities />, '/settings/capabilities?tab=project-skills');
    expect(await screen.findByText('Nothing found in project repositories')).toBeInTheDocument();
  });
});
