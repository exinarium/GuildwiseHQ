import { ArrowLeft, BookOpen, GraduationCap, Play, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { BlogSearchHits, HelpBlog } from '../components/blog/HelpBlog.tsx';
import { GettingStartedVideo } from '../components/help/GettingStartedVideo.tsx';
import { SectionVideo } from '../components/help/SectionVideo.tsx';
import { SetupHelpCard, useSetupChecklistUi } from '../components/setup/SetupChecklist.tsx';
import { useTour } from '../components/tour/TourContext.tsx';
import { panelId, Tabs, tabId } from '../components/ui/Tabs.tsx';
import { Badge, Button, EmptyState, ErrorBox, ListSkeleton, PageHeader, Panel } from '../components/ui.tsx';
import { useAllWhatsNew, WhatsNewDialog } from '../components/whatsnew/WhatsNew.tsx';
import { ext } from '../extension/index.ts';
import {
  articleBySlug,
  DEV_ONLY_HELP_SLUGS,
  glossaryId,
  helpArticlesFor,
  helpBase,
  helpPath,
  searchHelp,
} from '../help/articles.ts';
import { GLOSSARY } from '../help/glossary.ts';
import { Markdown } from '../help/Markdown.tsx';
import { useBusinessMode } from '../lib/orgMode.ts';
import { formatDateTime } from '../lib/time.ts';
import { usePageTitle } from '../lib/usePageTitle.ts';
import { videosForArticle } from '../lib/videos.ts';

/** Whether this build has a "Contact us" form (a hosted extension adds it; the open-source app has none). Read lazily: the extension may import this page. */
const contactAvailable = () => !!ext.helpTabs?.some((t) => t.id === 'contact');

function tabOf(pathname: string): string {
  if (pathname.startsWith('/help/blog')) return 'blog';
  for (const t of ext.helpTabs ?? []) if (pathname.startsWith(`/help/${t.id}`)) return t.id;
  return 'help';
}

/** The help centre: articles, glossary, tour, Contact us and My requests. */
export function Help() {
  const { pathname } = useLocation();
  const nav = useNavigate();
  const tab = tabOf(pathname);
  usePageTitle('Help');

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Help" sub="Answers, and a person when you need one." />
      <Tabs
        label="Help"
        prefix="help"
        value={tab}
        onChange={(id) => nav(id === 'help' ? '/help' : `/help/${id}`)}
        tabs={[
          { id: 'help', label: 'Help centre', testId: 'help-tab-help' },
          { id: 'blog', label: 'Blog', testId: 'help-tab-blog' },
          ...(ext.helpTabs ?? []).map((t) => ({
            id: t.id,
            label: t.label,
            testId: t.testId ?? `help-tab-${t.id}`,
            badge: t.Badge ? <t.Badge /> : undefined,
          })),
        ]}
        className="mb-5"
      />
      <div role="tabpanel" id={panelId('help', tab)} aria-labelledby={tabId('help', tab)}>
        {tab === 'help' && <HelpCentre />}
        {tab === 'blog' && <HelpBlog slug={pathname.split('/')[3]} />}
        {ext.helpTabs?.map((t) => (tab === t.id ? <t.Component key={t.id} /> : null))}
      </div>
    </div>
  );
}

/** The help centre of a platform administrator: the same articles and glossary, without Contact us. */
export function PlatformHelp() {
  usePageTitle('Help');
  const { pathname } = useLocation();
  const blog = pathname.startsWith('/platform/help/blog');
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Help" sub="Articles, the glossary, the blog and the tour." />
      {blog ? <HelpBlog slug={pathname.split('/')[4]} /> : <HelpCentre />}
    </div>
  );
}

function SetupCard() {
  const { data } = useSetupChecklistUi();
  if (!data || data.steps.length === 0) return null;
  return (
    <Panel>
      <SetupHelpCard />
    </Panel>
  );
}

function TourCard() {
  const tour = useTour();
  if (!tour.available) return null;
  const canResume =
    !tour.active &&
    (tour.status === 'dismissed' || tour.status === 'in_progress') &&
    tour.step > 0 &&
    tour.step < tour.total - 1;
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3" data-testid="help-tour">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
          <GraduationCap aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-fg">The guided tour</h2>
          <p className="text-sm text-muted">
            A walk of about three minutes through the sidebar, the desk, the agents and where to find help.
            {canResume && ` You stopped at step ${tour.step + 1} of ${tour.total}.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canResume && (
            <Button variant="secondary" onClick={tour.resume} data-testid="help-resume-tour">
              Resume the tour
            </Button>
          )}
          <Button variant="primary" onClick={tour.start} data-testid="help-replay-tour">
            <Play aria-hidden="true" className="size-4" />
            {tour.status === 'completed' || tour.status === 'dismissed' ? 'Replay the tour' : 'Take the tour'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** "What's new in Guildwise HQ": the release notes for this user, reopened here at any time. */
function WhatsNewCard() {
  const entries = useAllWhatsNew();
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3" data-testid="help-whats-new">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
          <Sparkles aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-fg">What’s new</h2>
          <p className="text-sm text-muted">The latest changes to Guildwise HQ, newest first.</p>
        </div>
        <Button variant="secondary" onClick={() => setOpen(true)} data-testid="help-open-whats-new">
          See what’s new
        </Button>
      </div>
      <WhatsNewDialog open={open} entries={entries} onClose={() => setOpen(false)} confirmLabel="Close" />
    </Panel>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-subtle"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Search the help articles"
        placeholder="Search the help, for example “budget”"
        data-testid="help-search"
        className="h-11 w-full rounded-control border border-control bg-surface pr-3 pl-10 text-base text-fg placeholder:text-subtle"
      />
    </div>
  );
}

function HelpCentre() {
  const { pathname, hash } = useLocation();
  const base = helpBase(pathname);
  const slug = pathname.startsWith(`${base}/`)
    ? pathname.slice(base.length + 1).split('/')[0] || undefined
    : undefined;
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const glossary = pathname === `${base}/glossary`;
  const business = useBusinessMode();
  const article =
    slug && !glossary && !(business && DEV_ONLY_HELP_SLUGS.includes(slug)) ? articleBySlug(slug) : undefined;
  const setQ = (v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set('q', v);
        else n.delete('q');
        return n;
      },
      { replace: true },
    );

  // a link like /help/agents#allow-lists scrolls to its section once the page is there; the old /help#install-troubleshooting is redirected
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the article or hash changes
  useEffect(() => {
    if (!hash) return;
    const id = decodeURIComponent(hash.slice(1));
    const t = setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 0);
    return () => clearTimeout(t);
  }, [hash, article?.slug, glossary]);

  const nav = useNavigate();
  useEffect(() => {
    if (pathname === base && hash === '#install-troubleshooting')
      nav(`${base}/install-troubleshooting`, { replace: true });
  }, [pathname, base, hash, nav]);

  return (
    <div className="flex flex-col gap-5" data-testid="help-articles">
      <SearchBox value={q} onChange={setQ} />
      {q.trim() ? (
        <Results q={q} base={base} />
      ) : glossary ? (
        <Glossary base={base} />
      ) : slug ? (
        <ArticleView article={article} base={base} />
      ) : (
        <Home base={base} />
      )}
    </div>
  );
}

function Results({ q, base }: { q: string; base: string }) {
  const business = useBusinessMode();
  const hits = useMemo(() => searchHelp(q, helpArticlesFor(business)), [q, business]);
  return (
    <section aria-label="Search results" data-testid="help-results">
      <p className="mb-2 text-sm text-muted" role="status">
        {hits.length === 0
          ? `Nothing found for “${q}”.`
          : `${hits.length} result${hits.length === 1 ? '' : 's'} for “${q}”.`}
      </p>
      {hits.length === 0 && (
        <EmptyState
          title="No help article matches"
          description="Try fewer or different words, or browse the list of articles. If it is not here, write to us."
          action={
            base === '/help' && contactAvailable() ? (
              <Link
                to="/help/contact"
                className="inline-flex h-9 items-center rounded-control bg-brand px-3.5 text-sm font-medium text-brand-fg hover:bg-brand-hover"
              >
                Contact us
              </Link>
            ) : undefined
          }
        />
      )}
      <ul className="flex flex-col gap-2">
        {hits.map((h) => (
          <li key={h.to + h.title}>
            <Link
              to={h.to.replace(/^\/help/, base)}
              data-testid="help-result"
              className="block rounded-card border border-line bg-surface p-3.5 hover:bg-sunken"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-fg">{h.title}</span>
                <Badge tone={h.kind === 'glossary' ? 'neutral' : 'brand'}>{h.where}</Badge>
              </span>
              <span className="mt-1 block text-sm text-muted">{h.snippet}</span>
            </Link>
          </li>
        ))}
      </ul>
      <BlogSearchHits q={q} />
    </section>
  );
}

function Home({ base }: { base: string }) {
  const business = useBusinessMode();
  return (
    <>
      <GettingStartedVideo />
      <SetupCard />
      <TourCard />
      <WhatsNewCard />
      <section aria-labelledby="help-articles-h">
        <h2 id="help-articles-h" className="mb-2 text-sm font-semibold tracking-wide text-subtle uppercase">
          Articles
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="help-article-list">
          {helpArticlesFor(business).map((a) => (
            <li key={a.slug}>
              <Link
                to={helpPath(a.slug, base)}
                data-testid={`help-article-${a.slug}`}
                className="flex h-full flex-col rounded-card border border-line bg-surface p-4 hover:bg-sunken"
              >
                <span className="text-base font-semibold text-fg">{a.title}</span>
                <span className="mt-1 text-sm text-muted">{a.summary}</span>
              </Link>
            </li>
          ))}
          <li>
            <Link
              to={`${base}/blog`}
              data-testid="help-blog-link"
              className="flex h-full flex-col rounded-card border border-line bg-surface p-4 hover:bg-sunken"
            >
              <span className="text-base font-semibold text-fg">Blog</span>
              <span className="mt-1 text-sm text-muted">
                Articles from the Guildwise HQ team on AI agents and automation.
              </span>
            </Link>
          </li>
          <li>
            <Link
              to={`${base}/glossary`}
              data-testid="help-glossary-link"
              className="flex h-full flex-col rounded-card border border-line bg-surface p-4 hover:bg-sunken"
            >
              <span className="flex items-center gap-2 text-base font-semibold text-fg">
                <BookOpen aria-hidden="true" className="size-4 text-brand-text" />
                Glossary
              </span>
              <span className="mt-1 text-sm text-muted">
                What card, stage, shift, desk, ledger, vault, phase and the other words of Guildwise HQ mean.
              </span>
            </Link>
          </li>
        </ul>
      </section>
      {base === '/help' && contactAvailable() && (
        <p className="text-sm text-muted">
          Not here?{' '}
          <Link to="/help/contact" className="font-medium text-brand-text underline-offset-2 hover:underline">
            Contact us
          </Link>
          .
        </p>
      )}
    </>
  );
}

function ArticleView({ article, base }: { article: ReturnType<typeof articleBySlug>; base: string }) {
  if (!article)
    return (
      <EmptyState
        title="That article does not exist"
        description="The link may be old. Browse the list of articles or search above."
        action={
          <Link
            to={base}
            className="inline-flex h-9 items-center rounded-control bg-brand px-3.5 text-sm font-medium text-brand-fg hover:bg-brand-hover"
          >
            All articles
          </Link>
        }
      />
    );
  const toc = article.headings.filter((h) => h.level === 2);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_14rem]" data-testid="help-article">
      <article className="min-w-0 rounded-card border border-line bg-surface p-5 sm:p-7">
        <Link
          to={base}
          className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-text hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All articles
        </Link>
        <h2 className="text-2xl font-semibold text-fg" data-testid="help-article-title">
          {article.title}
        </h2>
        <p className="mt-1 mb-4 text-base text-muted">{article.summary}</p>
        {article.slug === 'getting-started' && (
          <div className="mb-5">
            <GettingStartedVideo />
          </div>
        )}
        <Markdown
          blocks={article.blocks}
          afterHeading={(id) =>
            videosForArticle(article.slug)
              .filter((v) => v.anchor === id)
              .map((v) => (
                <SectionVideo
                  key={v.slug}
                  slug={v.slug}
                  className="rounded-card border border-line bg-surface p-4"
                />
              ))
          }
        />
        {base === '/help' && contactAvailable() && (
          <p className="mt-8 border-t border-line pt-4 text-sm text-muted">
            Still stuck?{' '}
            <Link
              to="/help/contact"
              className="font-medium text-brand-text underline-offset-2 hover:underline"
            >
              Contact us
            </Link>
            .
          </p>
        )}
      </article>
      {toc.length > 1 && (
        <nav aria-label="On this page" className="hidden lg:block">
          <div className="sticky top-20">
            <p className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">In this article</p>
            <ul className="flex flex-col gap-1.5 border-l border-line text-sm">
              {toc.map((h) => (
                <li key={h.id}>
                  <a
                    href={`#${h.id}`}
                    className="-ml-px block border-l border-transparent py-0.5 pl-3 text-muted hover:border-brand hover:text-fg"
                  >
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      )}
    </div>
  );
}

function Glossary({ base }: { base: string }) {
  const terms = [...GLOSSARY].sort((a, b) => a.term.localeCompare(b.term));
  return (
    <section aria-labelledby="glossary-h" data-testid="help-glossary">
      <Link
        to={base}
        className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-text hover:underline"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        All articles
      </Link>
      <h2 id="glossary-h" className="text-2xl font-semibold text-fg">
        Glossary
      </h2>
      <p className="mt-1 mb-4 text-base text-muted">The words Guildwise HQ uses, in plain language.</p>
      <dl className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
        {terms.map((g) => (
          <div key={g.term} id={glossaryId(g.term)} className="scroll-mt-20 px-4 py-3.5 sm:px-5">
            <dt className="text-base font-semibold text-fg">
              {g.term}
              {g.aka && g.aka.length > 0 && (
                <span className="ml-2 text-sm font-normal text-subtle">also: {g.aka.join(', ')}</span>
              )}
            </dt>
            <dd className="mt-1 text-sm text-muted">
              {g.definition}
              {g.article && (
                <>
                  {' '}
                  <Link
                    to={helpPath(g.article, base)}
                    className="font-medium text-brand-text underline-offset-2 hover:underline"
                  >
                    Read more
                  </Link>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
