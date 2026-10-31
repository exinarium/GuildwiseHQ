import { ORG_TERMS } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meKey } from '../api/queries/auth.ts';
import { PageHelpPanel } from '../components/help/PageHelpPanel.tsx';
import { RecommendationList } from '../components/hr/Recommendations.tsx';
import { LedgerForm } from '../components/LedgerForm.tsx';
import { crumbsFor } from '../components/shell/Breadcrumbs.tsx';
import { buildNav } from '../components/shell/nav-config.ts';
import { ToastProvider } from '../components/ui.tsx';
import { ARTICLES, helpArticlesFor } from '../help/articles.ts';
import { PAGE_HELP } from '../help/page-help-content.ts';
import { DeskItem } from '../pages/Desk.tsx';
import { DocumentsList } from '../pages/Documents.tsx';
import { Help } from '../pages/Help.tsx';
import { Ledger } from '../pages/Ledger.tsx';
import { Vaults } from '../pages/Vaults.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The words a business user must never see. */
const FORBIDDEN = /\b(vaults?|ledgers?|standing orders?)\b/i;

let mode: 'dev' | 'business' = 'business';

const me = () => ({
  user: {
    id: ID(1),
    email: 'o@x.test',
    displayName: 'Olga',
    kind: 'user',
    status: 'active',
    timezone: 'UTC',
  },
  account: { kind: 'user' },
  isAdmin: false,
  orgs: [{ id: ID(2), name: 'Org', role: 'owner', status: 'active' }],
  activeOrg: {
    id: ID(2),
    name: 'Org',
    role: 'owner',
    status: 'active',
    plan: 'founding',
    planName: 'Founding',
    features: {},
    mode,
    banners: [],
    gate: null,
  },
  guestIn: [],
  guestProjectIds: [],
  visibleProjectIds: [],
  pendingInvitations: 0,
  mustChangePassword: false,
  twoFactor: { enabled: false, required: false, setupRequired: false },
  features: { mockUi: false },
});

const entry = (over: Record<string, unknown> = {}) => ({
  id: ID(20),
  scope: 'standing_order',
  projectId: null,
  projectKey: null,
  cardId: null,
  cardRef: null,
  title: 'Working Branch',
  body: 'Ask which branch to use.',
  tags: [],
  sourceDeskItemId: null,
  vaultPath: null,
  createdByKind: 'user',
  createdByName: 'Olga',
  supersededBy: null,
  createdAt: '2026-10-13T10:00:00.000Z',
  version: 2,
  editedAt: '2026-10-14T10:00:00.000Z',
  editedByName: 'Olga',
  canEdit: true,
  canRetire: true,
  retiredAt: null,
  retiredReason: null,
  conflictsWith: [],
  ...over,
});

const vault = (over: Record<string, unknown> = {}) => ({
  id: ID(30),
  orgId: ID(2),
  projectId: null,
  kind: 'org',
  name: 'Organization vault',
  remoteUrl: 'git@example.test:acme/k.git',
  storage: 'git',
  syncIntervalSec: 300,
  createdAt: '2026-10-19T10:00:00.000Z',
  canEdit: true,
  workstations: [],
  ...over,
});

let entries: unknown[];
let vaults: unknown[];
beforeEach(() => {
  mode = 'business';
  entries = [entry(), entry({ id: ID(21), scope: 'decision', title: 'Use pnpm', version: 1 })];
  vaults = [vault(), vault({ id: ID(31), kind: 'project', projectId: ID(70), name: 'Project vault' })];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.split('?')[0] as string;
      if (path === '/api/auth/me') return json(me());
      if (path === '/api/projects') return json({ projects: [] });
      if (path === '/api/ledger') return json({ entries });
      if (path === '/api/vaults') return json({ vaults });
      if (path === '/api/documents') return json({ documents: [] });
      if (path.startsWith('/api/hr/recommendations/') && path.endsWith('/apply'))
        return json({ applied: true, effect: 'Proposed a standing order on the desk', deskItemId: ID(95) });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function wrap(ui: React.ReactElement, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(meKey, me());
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Everything a user can read or hear on the page: its text and the accessible names and hints. */
function shown(): string[] {
  const out = [document.body.textContent ?? ''];
  for (const el of document.body.querySelectorAll('[aria-label],[title],[placeholder]'))
    for (const a of ['aria-label', 'title', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v) out.push(v);
    }
  return out;
}
const expectClean = () => {
  for (const raw of shown()) {
    // the aom command line keeps its name (`aom ledger ...`) and so does a `vault:<path>` reference
    const s = raw.replace(/aom ledger( \w+)?/g, '');
    const m = s.match(FORBIDDEN);
    expect(m ? s.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 40) : '').toBe('');
  }
};

const deskItem = (over: Record<string, unknown> = {}) =>
  ({
    id: ID(90),
    kind: 'question',
    subkind: null,
    status: 'open',
    routedTo: 'manager',
    title: 'Which branch?',
    body: 'Pick one.',
    doing: null,
    options: [],
    recommendation: null,
    blocking: false,
    pinned: false,
    urgent: false,
    affectedCardIds: [],
    affectedCount: 0,
    askedBy: { kind: 'system' },
    card: null,
    projectId: null,
    dedupEntries: [],
    answer: null,
    answerOption: null,
    answeredAt: null,
    answeredByName: null,
    decisionPolicy: 'owner_only',
    canAnswer: true,
    createdAt: '2026-10-03T10:00:00.000Z',
    ...over,
  }) as never;

const standingOrderRec = () =>
  ({
    id: 'rework_reason:a:weak_tests',
    kind: 'rework_reason',
    title: 'Bea gets bounced for weak tests',
    summary: 'Two cards came back.',
    agentId: ID(1),
    agentName: 'Bea',
    roleKey: 'builder',
    evidence: { metrics: [], items: [] },
    action: { type: 'standing_order', text: 'Always ship tests.', topic: 'No or weak tests' },
    canApply: true,
  }) as never;

describe('a business org: the main pages never say Vault, Ledger or standing order', () => {
  it('the sidebar, the breadcrumbs and the command entries', () => {
    const t = ORG_TERMS.business;
    const labels = buildNav({ projectKey: 'APP', canManage: true, business: true, terms: t })
      .sections.flatMap((s) => s.items)
      .map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Rules & decisions', 'Knowledge']));
    for (const l of labels) expect(l).not.toMatch(FORBIDDEN);
    for (const p of ['/ledger', '/settings/vaults'])
      for (const c of crumbsFor(p, '', [], undefined, t)) expect(c.label).not.toMatch(FORBIDDEN);
  });

  it('Ledger: header, list, empty state and the add dialog', async () => {
    wrap(<Ledger />);
    expect(await screen.findByRole('heading', { name: 'Rules & decisions' })).toBeInTheDocument();
    await screen.findByText('Working Branch');
    expect(screen.getByRole('group', { name: 'Scope' })).toHaveTextContent('Rules');
    expectClean();
    await userEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getAllByText('Add to Rules & decisions').length).toBeGreaterThan(0);
    expect(within(dlg).getByRole('option', { name: /^Rule \(every agent loads it\)/ })).toBeInTheDocument();
    expectClean();
  });

  it('Desk: a vault conflict item and the answer form with its Add choices', async () => {
    wrap(
      <>
        <DeskItem
          bare
          item={deskItem({
            id: ID(91),
            kind: 'escalation',
            subkind: 'vault_conflict',
            title: 'Knowledge folder sync conflict: Organization knowledge',
            body: 'Local and remote edits to the knowledge folder cannot be merged automatically.',
          })}
        />
        <DeskItem bare item={deskItem()} />
      </>,
    );
    await screen.findByText('Add to Rules & decisions as');
    expect(screen.getAllByRole('option', { name: /^Rule \(/ })[0]).toBeInTheDocument();
    expectClean();
  });

  it('Agents: the recommendation apply button says Propose rule', async () => {
    wrap(<RecommendationList recommendations={[standingOrderRec()]} />);
    expect(screen.getByTestId('apply-rework_reason')).toHaveTextContent('Propose rule');
    expectClean();
  });

  it('Agents: the applied line of a proposed order says rule', async () => {
    wrap(<RecommendationList recommendations={[standingOrderRec()]} />);
    await userEvent.click(screen.getByTestId('apply-rework_reason'));
    expect(await screen.findByTestId('rec-applied')).toHaveTextContent('Proposed a rule on the desk.');
    expectClean();
  });

  it('Ledger: the empty state', async () => {
    entries = [];
    wrap(<Ledger />);
    expect(await screen.findByText('Rules & decisions is empty')).toBeInTheDocument();
    expectClean();
  });

  it('Knowledge page: default-named vaults read as Knowledge, the register dialog too', async () => {
    wrap(<Vaults />);
    expect(await screen.findByRole('heading', { name: 'Knowledge' })).toBeInTheDocument();
    await screen.findByText('Organization knowledge');
    expect(screen.getByText('Project knowledge')).toBeInTheDocument();
    expectClean();
    vaults = [];
  });

  it('Knowledge page: the empty state and the register dialog', async () => {
    vaults = [];
    wrap(<Vaults />);
    await screen.findByText('No knowledge folder yet');
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Register a knowledge folder' })[0] as HTMLElement,
    );
    await screen.findByRole('dialog');
    expectClean();
  });

  it('LedgerForm', () => {
    wrap(<LedgerForm />);
    expect(screen.getByRole('form', { name: 'Add to Rules & decisions' })).toBeInTheDocument();
    expectClean();
  });

  it('Documents', async () => {
    wrap(<DocumentsList />, '/documents');
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    expectClean();
  });

  it('Help: the article list, the Rules & decisions article and the glossary', async () => {
    wrap(<Help />, '/help');
    await screen.findByTestId('help-article-list');
    expectClean();
  });

  it('Help: the article and the glossary', async () => {
    wrap(<Help />, '/help/ledger-and-vaults');
    expect(await screen.findByTestId('help-article-title')).toHaveTextContent(
      'Rules & decisions and knowledge folders',
    );
    expectClean();
  });

  it('Help: the glossary keeps the anchors of the stored terms', async () => {
    wrap(<Help />, '/help/glossary');
    const dl = await screen.findByTestId('help-glossary');
    expect(dl.querySelector('#term-ledger')).not.toBeNull();
    expect(dl.querySelector('#term-vault')).not.toBeNull();
    expectClean();
  });

  it('the page help of the Rules & decisions and Knowledge pages', async () => {
    for (const path of ['/ledger', '/settings/vaults']) {
      const { unmount } = wrap(
        <Routes>
          <Route path={path} element={<PageHelpPanel open onOpenChange={() => undefined} />} />
        </Routes>,
        path,
      );
      await screen.findByTestId('page-help');
      expectClean();
      unmount();
    }
  });

  it('every help article and page help reads cleanly once reworded', async () => {
    const { rewordForOrg } = await import('@aom/shared');
    const bad: string[] = [];
    const check = (where: string, text: string) => {
      const r = rewordForOrg(text, 'business');
      const m = r.match(FORBIDDEN);
      if (m) bad.push(`${where}: ${r.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + 40)}`);
    };
    for (const a of helpArticlesFor(true)) {
      check(`${a.slug} title`, a.title);
      check(`${a.slug} summary`, a.summary);
      for (const h of a.headings) check(`${a.slug} heading`, h.text);
    }
    for (const [p, h] of Object.entries(PAGE_HELP)) {
      check(`${p} title`, h.title);
      check(`${p} intro`, h.intro);
      for (const c of h.controls) check(`${p} control`, `${c.name} ${c.text}`);
    }
    expect(ARTICLES.length).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});

describe('a dev org: the old words are unchanged', () => {
  beforeEach(() => {
    mode = 'dev';
  });
  it('Ledger page and add dialog', async () => {
    wrap(<Ledger />);
    expect(await screen.findByRole('heading', { name: 'Ledger' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Scope' })).toHaveTextContent('Standing orders');
    await userEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Add to the ledger')).toBeInTheDocument();
    expect(
      within(dlg).getByRole('option', { name: 'Standing order (every agent loads it)' }),
    ).toBeInTheDocument();
  });
  it('Desk: the answer form keeps the ledger words', async () => {
    wrap(<DeskItem bare item={deskItem()} />);
    expect(await screen.findByText('Add to ledger as')).toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: /^Standing order \(/ })[0]).toBeInTheDocument();
  });
  it('Agents: the recommendation apply button keeps Propose standing order', async () => {
    wrap(<RecommendationList recommendations={[standingOrderRec()]} />);
    expect(screen.getByTestId('apply-rework_reason')).toHaveTextContent('Propose standing order');
  });
  it('Agents: the applied line of a proposed order keeps standing order', async () => {
    wrap(<RecommendationList recommendations={[standingOrderRec()]} />);
    await userEvent.click(screen.getByTestId('apply-rework_reason'));
    expect(await screen.findByTestId('rec-applied')).toHaveTextContent(
      'Proposed a standing order on the desk.',
    );
  });
  it('Vaults page', async () => {
    wrap(<Vaults />);
    expect(await screen.findByRole('heading', { name: 'Vaults' })).toBeInTheDocument();
    expect(await screen.findByText('Organization vault')).toBeInTheDocument();
    expect(screen.getByText('Project vault')).toBeInTheDocument();
  });
  it("the nav and breadcrumbs without terms are today's", () => {
    const labels = buildNav({ projectKey: 'APP', canManage: true })
      .sections.flatMap((s) => s.items)
      .map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Ledger', 'Vaults']));
    expect(crumbsFor('/ledger', '', [])).toEqual([{ label: 'Knowledge' }, { label: 'Ledger' }]);
    expect(crumbsFor('/settings/vaults', '', [])).toEqual([{ label: 'Knowledge' }, { label: 'Vaults' }]);
  });
  it('the Ledger article keeps its title', async () => {
    wrap(<Help />, '/help/ledger-and-vaults');
    expect(await screen.findByTestId('help-article-title')).toHaveTextContent('Ledger and vaults');
  });
});
