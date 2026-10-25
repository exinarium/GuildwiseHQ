import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, matchPath, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpHint } from '../components/help/HelpHint.tsx';
import { PageHelpPanel } from '../components/help/PageHelpPanel.tsx';
import { TourProvider } from '../components/tour/Tour.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { ARTICLES, articleBySlug, buildArticle, RESERVED_SLUGS, searchHelp } from '../help/articles.ts';
import { GLOSSARY } from '../help/glossary.ts';
import { parseBlocks, parseFrontmatter, parseInline } from '../help/markdown.ts';
import { PAGE_HELP } from '../help/page-help-content.ts';
import { NO_PAGE_HELP, PAGE_HELP_ALIAS, pageHelpFor } from '../help/pageHelp.ts';
import { tourSteps } from '../lib/tour.ts';
import { Help } from '../pages/Help.tsx';
import { routes } from '../router.tsx';

/** `slug` or `slug#anchor` resolves to a real article (and section). */
function resolves(ref: string): boolean {
  const [slug, anchor] = ref.split('#');
  const a = articleBySlug(slug ?? '');
  if (!a) return false;
  return !anchor || a.headings.some((h) => h.id === anchor);
}

const flatten = (rs: Array<{ path?: string; children?: unknown[] }>): string[] =>
  rs.flatMap((r) => [...(r.path ? [r.path] : []), ...flatten((r.children ?? []) as typeof rs)]);

describe('the markdown reader', () => {
  it('reads front matter, headings with anchors, lists, quotes, code and inline marks', () => {
    const { meta, body } = parseFrontmatter(
      '---\ntitle: T\nsummary: S\nkeywords: [a, b c]\norder: 4\n---\nIntro **bold** and `code`.\n\n## One {#uno}\n- x\n- y\n\n1. a\n2. b\n\n> Note: hi\n\n```\nraw\n```\n\n### Sub\n',
    );
    expect(meta).toEqual({ title: 'T', summary: 'S', keywords: ['a', 'b c'], order: 4 });
    const blocks = parseBlocks(body);
    expect(blocks.map((b) => b.t)).toEqual(['p', 'h', 'ul', 'ol', 'quote', 'code', 'h']);
    expect(blocks[1]).toMatchObject({ id: 'uno', level: 2 });
    expect(blocks[6]).toMatchObject({ id: 'sub', level: 3 });
    expect(parseInline('see [the guide](/help/agents#focus) *now*')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: '/help/agents#focus', c: [{ t: 'text', v: 'the guide' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'now' }] },
    ]);
  });
});

describe('the help articles', () => {
  it('cover every feature area, with a title, a summary and sections', () => {
    const slugs = ARTICLES.map((a) => a.slug);
    for (const s of [
      'getting-started',
      'organizations-and-roles',
      'two-factor',
      'agents',
      'phases',
      'interests',
      'automations-and-integrations',
      'budgets-and-costs',
      'org-chart-and-design',
      'workstations-and-installer',
      'install-troubleshooting',
      'devops-and-hygiene',
      'ba-reporter',
      'project-conversion',
      'writing-to-us',
    ])
      expect(slugs).toContain(s);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const a of ARTICLES) {
      expect(RESERVED_SLUGS).not.toContain(a.slug);
      expect(a.title.length, a.slug).toBeGreaterThan(3);
      expect(a.summary.length, a.slug).toBeGreaterThan(10);
      expect(a.summary.length, a.slug).toBeLessThanOrEqual(160);
      expect(a.sections.length, a.slug).toBeGreaterThanOrEqual(2);
      const ids = a.headings.map((h) => h.id);
      expect(new Set(ids).size, a.slug).toBe(ids.length);
    }
  });

  it('every link in an article, the glossary, the page help and the tour leads somewhere that exists', () => {
    const appPaths = flatten(routes as never);
    const bad: string[] = [];
    const check = (ref: string, from: string) => {
      if (RESERVED_SLUGS.includes(ref)) return;
      if (!resolves(ref)) bad.push(`${from}: ${ref}`);
    };
    const walk = (c: ReturnType<typeof parseInline>, from: string) => {
      for (const n of c) {
        if (n.t === 'link') {
          const m = /^\/help\/([^#]+(?:#.+)?)$/.exec(n.href);
          if (m) check(m[1] as string, from);
          else if (n.href.startsWith('/')) {
            const path = n.href.split(/[?#]/)[0] as string;
            if (!appPaths.some((p) => matchPath({ path: p, end: true }, path)))
              bad.push(`${from}: ${n.href}`);
          }
        }
        if ('c' in n) walk(n.c, from);
      }
    };
    for (const a of ARTICLES)
      for (const b of a.blocks) {
        if (b.t === 'p' || b.t === 'quote') walk(b.c, a.slug);
        if (b.t === 'ul' || b.t === 'ol') for (const it of b.items) walk(it, a.slug);
      }
    for (const g of GLOSSARY) if (g.article) check(g.article, `glossary ${g.term}`);
    for (const [route, h] of Object.entries(PAGE_HELP)) if (h.article) check(h.article, `page help ${route}`);
    for (const role of ['manager', 'member', 'guest', 'platform'] as const)
      for (const s of tourSteps(role, new Set())) if (s.more) check(s.more, `tour ${role} ${s.id}`);
    expect(bad).toEqual([]);
  });

  it('every ? hint in the app points at an existing article section', () => {
    const files = import.meta.glob('../components/**/*.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const found: string[] = [];
    for (const [file, src] of Object.entries(files))
      for (const m of String(src).matchAll(/<HelpHint\s+article="([^"]+)"/g)) {
        found.push(m[1] as string);
        expect(resolves(m[1] as string), `${file}: ${m[1]}`).toBe(true);
      }
    // phase follow-ups, interest run/delivery and the quiet cap, budgets, allow-lists and focus, schedule triggers and actions, conversion, 2FA
    for (const need of [
      'phases#followups',
      'interests#run-and-delivery',
      'interests#quiet-cap',
      'budgets-and-costs#override',
      'agents#allow-lists',
      'agents#focus',
      'automations-and-integrations#triggers',
      'automations-and-integrations#actions',
      'project-conversion#converting',
      'two-factor#enforcement',
    ])
      expect(found, need).toContain(need);
  });

  it('the glossary has the terms of the app', () => {
    const terms = GLOSSARY.map((g) => g.term.toLowerCase());
    for (const t of [
      'card',
      'stage',
      'shift',
      'handoff',
      'desk',
      'ledger',
      'vault',
      'phase',
      'follow-up',
      'interest',
      'delivery',
      'taste',
      'devops engineer',
      'ba',
      'runner',
      'workstation',
      'allow-list',
      'focus',
      'budget',
      'guest',
    ])
      expect(terms, t).toContain(t);
  });
});

describe('searching the help', () => {
  it('finds a section by its words, best match first, and a glossary term', () => {
    expect(
      searchHelp('allow-list')
        .slice(0, 5)
        .map((h) => h.to),
    ).toContain('/help/agents#allow-lists');
    expect(searchHelp('quiet cap').some((h) => h.to === '/help/interests#quiet-cap')).toBe(true);
    expect(searchHelp('override budget').some((h) => h.to === '/help/budgets-and-costs#override')).toBe(true);
    expect(searchHelp('two-factor enforcement')[0]?.to).toMatch(/^\/help\/two-factor/);
    expect(searchHelp('ledger').some((h) => h.kind === 'glossary' && h.title === 'Ledger')).toBe(true);
    expect(searchHelp('pairing code expired')[0]?.to).toMatch(/install-troubleshooting/);
  });

  it('needs every word, ignores case and accents, and finds nothing for nonsense', () => {
    expect(searchHelp('ALLOW-LIST').length).toBeGreaterThan(0);
    expect(searchHelp('zzzqqxx')).toEqual([]);
    expect(searchHelp('   ')).toEqual([]);
    expect(searchHelp('allow-list zzzqqxx')).toEqual([]);
  });

  it('works on any article text', () => {
    const a = buildArticle(
      't',
      '---\ntitle: Zebra care\nsummary: Feeding\nkeywords: [stripes]\norder: 1\n---\nIntro\n\n## Hay {#hay}\nGive lucerne daily.\n',
    );
    expect(searchHelp('lucerne', [a])[0]?.to).toBe('/help/t#hay');
    expect(searchHelp('stripes', [a])[0]?.title).toBe('Zebra care');
  });
});

describe('what is on this page', () => {
  it('has help for every route of the app (redirects and public pages aside)', () => {
    const all = flatten(routes as never);
    const missing = all.filter((p) => !NO_PAGE_HELP.includes(p) && !PAGE_HELP[p] && !PAGE_HELP_ALIAS[p]);
    expect(missing).toEqual([]);
    for (const p of NO_PAGE_HELP) expect(all, `${p} is not a route`).toContain(p);
    // no help for a route that is gone
    for (const k of Object.keys(PAGE_HELP)) expect(all.concat('/platform/help'), k).toContain(k);
    for (const [k, h] of Object.entries(PAGE_HELP)) {
      expect(h.title.length, k).toBeGreaterThan(2);
      expect(h.intro.length, k).toBeGreaterThan(20);
      expect(h.controls.length, k).toBeGreaterThanOrEqual(1);
      for (const c of h.controls) {
        expect(c.name.length, k).toBeGreaterThan(0);
        expect(c.text.length, `${k} ${c.name}`).toBeGreaterThan(10);
      }
      expect(h.article, k).toBeTruthy();
    }
  });

  it('finds the right page for a real address', () => {
    expect(pageHelpFor('/p/TOY/board')?.pattern).toBe('/p/:projectKey/board');
    expect(pageHelpFor('/cards/TOY-7')?.pattern).toBe('/cards/:ref');
    expect(pageHelpFor('/cards/new')?.pattern).toBe('/cards/new');
    expect(pageHelpFor('/platform/orgs/1')?.pattern).toBe('/platform/orgs/:id');
  });
});

// ---------------------------------------------------------------- screens

const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const U = '0192f3a0-0000-7000-8000-000000000001';
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/me')
        return json({
          user: {
            id: U,
            email: 'me@example.test',
            displayName: 'Me',
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastLoginAt: null,
            tour: { status: 'dismissed', step: 4 },
          },
          isAdmin: true,
          visibleProjectIds: [],
          features: { mockUi: false },
        });
      if (url === '/api/support/tickets') return json({ tickets: [] });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: React.ReactNode, path: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <TourProvider navIds={new Set(['board'])} mobile={false}>
            {ui}
          </TourProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('the Help centre', () => {
  it('lists the articles and the glossary and searches as you type', async () => {
    const user = userEvent.setup();
    wrap(<Help />, '/help');
    const list = await screen.findByTestId('help-article-list');
    expect(within(list).getAllByRole('link').length).toBe(ARTICLES.length + 2); // the articles, the blog and the glossary
    await user.type(screen.getByTestId('help-search'), 'allow-list');
    const results = await screen.findByTestId('help-results');
    expect(
      within(results)
        .getAllByTestId('help-result')
        .map((r) => r.getAttribute('href')),
    ).toContain('/help/agents#allow-lists');
    await user.clear(screen.getByTestId('help-search'));
    await user.type(screen.getByTestId('help-search'), 'qqzzxx');
    expect(await screen.findByText(/Nothing found/)).toBeInTheDocument();
  });

  it('shows an article with its anchors and the glossary page', async () => {
    wrap(<Help />, '/help/agents#focus');
    expect(await screen.findByTestId('help-article-title')).toHaveTextContent(
      articleBySlug('agents')?.title ?? '',
    );
    expect(document.getElementById('focus')).not.toBeNull();
  });

  it('shows the glossary', async () => {
    wrap(<Help />, '/help/glossary');
    const g = await screen.findByTestId('help-glossary');
    expect(within(g).getByText('Allow-list')).toBeInTheDocument();
  });

  it('says so for an article that does not exist', async () => {
    wrap(<Help />, '/help/nope');
    expect(await screen.findByText('That article does not exist')).toBeInTheDocument();
  });

  it('offers to replay or resume the tour', async () => {
    wrap(<Help />, '/help');
    expect(await screen.findByTestId('help-replay-tour')).toHaveTextContent('Replay the tour');
  });
});

describe('the page help panel and the ? hints', () => {
  it('explains the controls of the page behind it, with a link to the article', async () => {
    wrap(
      <Routes>
        <Route path="/desk" element={<PageHelpPanel open onOpenChange={() => undefined} />} />
      </Routes>,
      '/desk',
    );
    const panel = await screen.findByTestId('page-help');
    expect(within(panel).getByRole('heading', { name: PAGE_HELP['/desk']?.title })).toBeInTheDocument();
    expect(within(panel).getByTestId('page-help-controls').children.length).toBe(
      PAGE_HELP['/desk']?.controls.length,
    );
    expect(within(panel).getByTestId('page-help-article')).toHaveAttribute(
      'href',
      `/help/${PAGE_HELP['/desk']?.article}`,
    );
  });

  it('a hint opens a short explanation with a link to the article', async () => {
    const user = userEvent.setup();
    wrap(
      <HelpHint article="phases#followups" label="About follow-ups">
        Follow-ups run after a phase.
      </HelpHint>,
      '/projects',
    );
    await user.click(screen.getByRole('button', { name: 'About follow-ups' }));
    expect(await screen.findByText('Follow-ups run after a phase.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('help-hint-link')).toHaveAttribute('href', '/help/phases#followups'),
    );
  });
});
