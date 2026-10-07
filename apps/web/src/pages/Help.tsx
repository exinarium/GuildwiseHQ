import { SUPPORT_KIND_LABELS } from '@aom/shared';
import { useEffect } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMyTickets } from '../api/queries/support.ts';
import { ContactForm, prefillFor } from '../components/support/ContactForm.tsx';
import { MyRequest } from '../components/support/MyRequest.tsx';
import { StatusBadge } from '../components/support/StatusBadge.tsx';
import { Tabs } from '../components/ui/Tabs.tsx';
import { Badge, EmptyState, ErrorBox, ListSkeleton, PageHeader, Panel } from '../components/ui.tsx';
import { HELP_ARTICLES } from '../lib/help-articles.ts';
import { formatDateTime } from '../lib/time.ts';

type Tab = 'help' | 'contact' | 'requests';

function tabOf(pathname: string): Tab {
  if (pathname.startsWith('/help/contact')) return 'contact';
  if (pathname.startsWith('/help/requests')) return 'requests';
  return 'help';
}

/** The help centre: articles, Contact us and My requests (docs/design/open-questions.md "Contact us"). */
export function Help() {
  const { pathname, hash } = useLocation();
  const nav = useNavigate();
  const tab = tabOf(pathname);
  const requests = useMyTickets();
  const fresh = requests.data?.filter((t) => t.hasReply).length ?? 0;

  // a link like /help#install-troubleshooting scrolls to its article once the page is there
  useEffect(() => {
    if (tab !== 'help' || !hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [tab, hash]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Help" sub="Answers, and a person when you need one." />
      <Tabs
        label="Help"
        prefix="help"
        value={tab}
        onChange={(id) => nav(id === 'help' ? '/help' : `/help/${id}`)}
        tabs={[
          { id: 'help', label: 'Help centre', testId: 'help-tab-help' },
          { id: 'contact', label: 'Contact us', testId: 'help-tab-contact' },
          {
            id: 'requests',
            label: 'My requests',
            testId: 'help-tab-requests',
            badge: fresh > 0 ? <Badge tone="brand">{fresh} new</Badge> : undefined,
          },
        ]}
        className="mb-5"
      />
      {tab === 'help' && <Articles />}
      {tab === 'contact' && <ContactTab />}
      {tab === 'requests' && <RequestsTab />}
    </div>
  );
}

function Articles() {
  return (
    <div className="flex flex-col gap-5" data-testid="help-articles">
      {HELP_ARTICLES.map((a) => (
        <Panel key={a.id}>
          <section id={a.id} aria-labelledby={`${a.id}-h`} className="scroll-mt-20">
            <h2 id={`${a.id}-h`} className="text-lg font-semibold text-fg">
              {a.title}
            </h2>
            <p className="mt-1 text-base text-muted">{a.intro}</p>
            <dl className="mt-4 flex flex-col gap-4">
              {a.entries.map((e) => (
                <div key={e.q}>
                  <dt className="text-base font-medium text-fg">{e.q}</dt>
                  <dd className="mt-0.5 text-sm text-muted">{e.a}</dd>
                </div>
              ))}
            </dl>
          </section>
        </Panel>
      ))}
      <p className="text-sm text-muted">
        Not here?{' '}
        <Link to="/help/contact" className="font-medium text-brand-text underline-offset-2 hover:underline">
          Contact us
        </Link>
        .
      </p>
    </div>
  );
}

function ContactTab() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  return (
    <Panel>
      <div className="max-w-2xl" data-testid="help-contact">
        <h2 className="mb-1 text-lg font-semibold text-fg">Contact us</h2>
        <p className="mb-4 text-sm text-muted">
          We answer by email, and the answer also appears under My requests. Tell us what you were doing: the
          form adds the page, the version and your browser.
        </p>
        <ContactForm
          mode="member"
          prefill={prefillFor(params.get('from'))}
          canCapture
          onCancel={() => nav('/help')}
        />
      </div>
    </Panel>
  );
}

function RequestsTab() {
  const { id } = useParams();
  const list = useMyTickets();
  if (id) return <MyRequest id={id} />;
  return (
    <div data-testid="my-requests">
      {list.isPending && <ListSkeleton label="Loading your requests" rows={3} />}
      {list.isError && <ErrorBox error={list.error} onRetry={() => list.refetch()} />}
      {list.data?.length === 0 && (
        <EmptyState
          title="No requests yet"
          description="When you write to us, your request and our answer appear here."
          action={
            <Link
              to="/help/contact"
              className="inline-flex h-9 items-center rounded-control bg-brand px-3.5 text-sm font-medium text-brand-fg hover:bg-brand-hover"
            >
              Contact us
            </Link>
          }
        />
      )}
      <ul className="flex flex-col gap-2">
        {list.data?.map((t) => (
          <li key={t.id}>
            <Link
              to={`/help/requests/${t.id}`}
              data-testid={`request-${t.ref}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-line bg-surface p-3 hover:bg-sunken"
            >
              <span className="font-mono text-xs text-subtle">{t.ref}</span>
              <span className="min-w-0 flex-1 text-base font-medium text-fg">{t.subject}</span>
              <Badge tone="neutral">{SUPPORT_KIND_LABELS[t.kind]}</Badge>
              <StatusBadge status={t.status} />
              {t.hasReply && <Badge tone="brand">New reply</Badge>}
              <span className="text-xs text-subtle">{formatDateTime(t.lastMessageAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
