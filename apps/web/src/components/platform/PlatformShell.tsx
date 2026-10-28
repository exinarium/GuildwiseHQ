import {
  Building2,
  CircleHelp,
  Download,
  KeyRound,
  LogOut,
  type LucideIcon,
  MailPlus,
  MailQuestion,
  Newspaper,
  ScrollText,
  Users,
  Wrench,
} from 'lucide-react';
import { type ComponentType, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { useLogout, useMe } from '../../api/queries/auth.ts';
import { useBlogSummary } from '../../api/queries/blog.ts';
import { ext } from '../../extension/index.ts';
import { PageHelpPanel } from '../help/PageHelpPanel.tsx';
import { Logo } from '../Logo.tsx';
import { TourProvider } from '../tour/Tour.tsx';
import { cx } from '../ui/cx.ts';
import { Button, Callout } from '../ui.tsx';
import { WhatsNewHost } from '../whatsnew/WhatsNew.tsx';

const CORE_NAV: Array<{ to: string; label: string; icon: LucideIcon; end: boolean; Badge?: ComponentType }> =
  [
    { to: '/platform', label: 'Organizations', icon: Building2, end: true },
    { to: '/platform/invitations', label: 'Invitations', icon: MailPlus, end: false },
    { to: '/platform/users', label: 'Accounts', icon: Users, end: false },
    { to: '/platform/blog', label: 'Blog', icon: Newspaper, end: false },
    { to: '/platform/api-keys', label: 'API keys', icon: KeyRound, end: false },
    { to: '/platform/runners', label: 'Runners', icon: Download, end: false },
    { to: '/platform/team', label: 'Platform team', icon: Wrench, end: false },
    { to: '/platform/inbound', label: 'Inbound mail', icon: MailQuestion, end: false },
    { to: '/platform/audit', label: 'Audit log', icon: ScrollText, end: false },
  ];

/** The core's entries with the extension's inserted after the item each names (default: at the end). */
const NAV = (() => {
  const items = [...CORE_NAV];
  for (const x of ext.platformNav ?? []) {
    const at = x.after ? items.findIndex((i) => i.to === x.after) : -1;
    const item = {
      to: x.to,
      label: x.label,
      icon: x.icon,
      end: false,
      ...(x.Badge ? { Badge: x.Badge } : {}),
    };
    items.splice(at >= 0 ? at + 1 : items.length, 0, item);
  }
  return items;
})();

const NO_NAV: ReadonlySet<string> = new Set();

/** The platform administrator's own frame: organizations, invitations, accounts and the audit log. No work navigation. */
export function PlatformShell() {
  const me = useMe();
  const logout = useLogout();
  const [pageHelp, setPageHelp] = useState(false);
  const blog = useBlogSummary();
  return (
    <TourProvider navIds={NO_NAV} mobile={false}>
      <div className="flex min-h-dvh flex-col bg-canvas" data-testid="platform-shell">
        <header className="bg-side text-side-strong">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
            <Logo variant="dark" height={26} />
            <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium tracking-wide uppercase">
              Platform
            </span>
            <nav
              aria-label="Platform"
              className="order-last -mx-1 flex w-full gap-1 overflow-x-auto sm:order-none sm:mx-0 sm:w-auto"
            >
              {NAV.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  data-testid={`platform-nav-${n.to.split('/')[2] ?? 'orgs'}`}
                  data-tour={`platform-nav-${n.to.split('/')[2] ?? 'orgs'}`}
                  className={({ isActive }) =>
                    cx(
                      'inline-flex min-h-9 shrink-0 items-center gap-2 rounded-control px-3 text-sm font-medium whitespace-nowrap',
                      isActive
                        ? 'bg-side-active text-white'
                        : 'text-side-label hover:bg-side-hover hover:text-white',
                    )
                  }
                >
                  <n.icon aria-hidden="true" className="size-4" />
                  {n.label}
                  {n.Badge && <n.Badge />}
                  {n.to === '/platform/blog' &&
                    (blog.data?.pending ?? 0) +
                      (blog.data?.pendingReleases ?? 0) +
                      (blog.data?.pendingVideos ?? 0) >
                      0 && (
                      <span
                        data-testid="blog-pending-badge"
                        className="rounded-full bg-accent px-1.5 text-xs font-semibold text-accent-fg"
                        title="Posts waiting for review"
                      >
                        {(blog.data?.pending ?? 0) +
                          (blog.data?.pendingReleases ?? 0) +
                          (blog.data?.pendingVideos ?? 0)}
                      </span>
                    )}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3">
              <button
                type="button"
                onClick={() => setPageHelp(true)}
                data-tour="page-help"
                data-testid="page-help-button"
                aria-label="What is on this page"
                className="inline-flex size-9 items-center justify-center rounded-control text-side-label hover:bg-side-hover hover:text-white"
              >
                <CircleHelp aria-hidden="true" className="size-5" />
              </button>
              <Link
                to="/platform/help"
                data-tour="platform-help"
                data-testid="platform-help-link"
                className="inline-flex min-h-9 items-center rounded-control px-3 text-sm font-medium text-side-label hover:bg-side-hover hover:text-white"
              >
                Help
              </Link>
              <span className="hidden text-sm text-side-label sm:inline">{me.data?.user.email}</span>
              <Button variant="secondary" size="sm" onClick={() => logout.mutate()}>
                <LogOut aria-hidden="true" className="size-4" />
                Log out
              </Button>
            </div>
          </div>
        </header>
        {ext.PlatformBanner && <ext.PlatformBanner />}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
          <Outlet />
        </main>
        <PageHelpPanel open={pageHelp} onOpenChange={setPageHelp} />
        <WhatsNewHost />
      </div>
    </TourProvider>
  );
}
