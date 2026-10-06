import * as RadixDialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Inbox, Menu, MessageSquare, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useLogout, useMe } from '../../api/queries/auth.ts';
import { useDesk } from '../../api/queries/desk.ts';
import { BRAND } from '../../brand.ts';
import { useIsDesktop, useIsTabletUp } from '../../lib/useMediaQuery.ts';
import { getSocket, useSocketState } from '../../ws/socket.ts';
import { ChatDrawer } from '../ChatDrawer.tsx';
import { cx } from '../ui/cx.ts';
import { Breadcrumbs, crumbsFor } from './Breadcrumbs.tsx';
import { buildNav } from './nav-config.ts';
import { CollapseButton, SidebarBody } from './Sidebar.tsx';
import { useCurrentProject } from './useCurrentProject.ts';

const SIDEBAR_KEY = `${BRAND.storagePrefix}-sidebar`;
const readCollapsed = (): boolean => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
  } catch {
    return false;
  }
};

function LiveIndicator({ live, compact = false }: { live: string; compact?: boolean }) {
  const open = live === 'open';
  return (
    <span
      className="inline-flex items-center gap-1.5 text-sm text-muted"
      title={`Live updates: ${live}`}
      data-testid="live-indicator"
      data-state={live}
    >
      <span
        aria-hidden="true"
        className={cx('size-2 rounded-full', open ? 'animate-pulse-soft bg-success-fill' : 'bg-warning-fill')}
      />
      <span className={compact ? 'sr-only' : undefined}>{open ? 'Live' : 'Reconnecting'}</span>
    </span>
  );
}

/** The signed-in application frame: dark sidebar (rail on tablets, drawer on phones), top bar, `main`. */
export function AppShell({ isAdmin, name, live }: { isAdmin: boolean; name: string; live: string }) {
  const me = useMe();
  const logout = useLogout();
  const desk = useDesk();
  const { project, projects } = useCurrentProject();
  const isDesktop = useIsDesktop();
  const isTabletUp = useIsTabletUp();
  const { pathname, search } = useLocation();
  const [pref, setPref] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [chat, setChat] = useState(false);
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  const counts = { open: desk.data?.counts.open ?? 0, blocking: desk.data?.counts.blocking ?? 0 };
  const { sections, footer } = buildNav({
    projectKey: project?.key ?? null,
    isFeed: project?.workflowKey === 'feed',
    isAdmin,
  });
  const collapsed = isTabletUp && (!isDesktop || pref);
  const user = { name, email: me.data?.user.email ?? '', isAdmin };
  const signOut = () => logout.mutate();

  // biome-ignore lint/correctness/useExhaustiveDependencies: route changes only
  useEffect(() => {
    setDrawer(false);
    if (first.current) {
      first.current = false;
      return;
    }
    if (!window.location.hash) {
      window.scrollTo?.(0, 0);
      main.current?.focus({ preventScroll: true });
    }
  }, [pathname]);
  useEffect(() => {
    if (isTabletUp) setDrawer(false);
  }, [isTabletUp]);

  const toggle = () => {
    const next = !pref;
    setPref(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? 'collapsed' : 'expanded');
    } catch {
      /* storage blocked: the toggle still works for this page */
    }
  };

  const crumbs = crumbsFor(pathname, search, projects);
  const pageName = crumbs.at(-1)?.label ?? BRAND.name;

  return (
    <Tooltip.Provider delayDuration={300} skipDelayDuration={100}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-90 focus:rounded-control focus:bg-brand focus:px-4 focus:py-2 focus:text-brand-fg"
      >
        Skip to content
      </a>
      <div
        className="min-h-dvh md:grid md:grid-cols-[var(--sidebar-w)_1fr] md:transition-[grid-template-columns] md:duration-200"
        style={{ ['--sidebar-w' as string]: isTabletUp ? (collapsed ? '4rem' : '16rem') : '0px' }}
      >
        {isTabletUp && (
          <aside className="sticky top-0 z-30 h-dvh overflow-hidden bg-side">
            <SidebarBody
              sections={sections}
              footer={footer}
              collapsed={collapsed}
              counts={counts}
              project={project}
              projects={projects}
              user={user}
              onSignOut={signOut}
              headerSlot={
                isDesktop && !collapsed ? <CollapseButton collapsed={false} onToggle={toggle} /> : undefined
              }
            />
          </aside>
        )}

        <div className="flex min-h-dvh min-w-0 flex-col">
          {isTabletUp ? (
            <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-line bg-canvas/85 px-6 backdrop-blur lg:px-8">
              <div className="flex min-w-0 items-center gap-3">
                {isDesktop && collapsed && <CollapseButtonLight onToggle={toggle} />}
                <Breadcrumbs projects={projects} />
              </div>
              <div className="flex shrink-0 items-center gap-4">
                <LiveIndicator live={live} />
                <button
                  type="button"
                  onClick={() => setChat(true)}
                  aria-label="Chat with an agent"
                  className="inline-flex h-9 items-center gap-2 rounded-control border border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-sunken"
                >
                  <MessageSquare aria-hidden="true" className="size-4" />
                  Chat
                </button>
              </div>
            </header>
          ) : (
            <header className="sticky top-0 z-20 flex min-h-14 items-center gap-1 border-b border-line bg-canvas/90 px-2 pt-[env(safe-area-inset-top)] backdrop-blur">
              <button
                type="button"
                onClick={() => setDrawer(true)}
                aria-label="Open menu"
                aria-expanded={drawer}
                aria-haspopup="dialog"
                className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-control text-fg hover:bg-sunken"
              >
                <Menu aria-hidden="true" className="size-5" />
                {counts.blocking > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute top-2.5 right-2.5 size-2 rounded-full bg-danger-fill"
                  />
                )}
              </button>
              <div className="min-w-0 flex-1 px-1">
                <p className="truncate text-base font-semibold text-fg">{pageName}</p>
                {project && <p className="truncate text-xs text-subtle">{project.name}</p>}
              </div>
              <Link
                to={project ? `/cards/new?project=${project.key}` : '/cards/new'}
                aria-label="New card"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-fg hover:bg-sunken"
              >
                <Plus aria-hidden="true" className="size-5" />
              </Link>
              <Link
                to="/desk"
                aria-label="Desk"
                className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-control text-fg hover:bg-sunken"
              >
                <Inbox aria-hidden="true" className="size-5" />
                {counts.open > 0 && (
                  <span
                    data-testid="desk-badge"
                    title={`${counts.blocking} blocking, ${counts.open} open`}
                    className={cx(
                      'tnum absolute top-1 right-0.5 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[11px] font-semibold',
                      counts.blocking > 0 ? 'bg-danger-fill text-white' : 'bg-accent text-accent-fg',
                    )}
                  >
                    {counts.open}
                  </span>
                )}
              </Link>
              <span className="pr-2 pl-1">
                <LiveIndicator live={live} compact />
              </span>
            </header>
          )}
          <main
            id="main"
            ref={main}
            tabIndex={-1}
            className="mx-auto w-full min-w-0 flex-1 px-4 py-5 outline-none sm:px-6 sm:py-6 lg:px-8"
          >
            <Outlet />
          </main>
        </div>
      </div>

      {!isTabletUp && (
        <RadixDialog.Root open={drawer} onOpenChange={setDrawer}>
          <RadixDialog.Portal>
            <RadixDialog.Overlay className="fixed inset-0 z-40 animate-fade bg-overlay" />
            <RadixDialog.Content
              aria-label="Main menu"
              aria-describedby={undefined}
              className="fixed inset-y-0 left-0 z-50 w-[min(86vw,20rem)] animate-drawer bg-side pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] shadow-lg"
            >
              <RadixDialog.Title className="sr-only">Main menu</RadixDialog.Title>
              <SidebarBody
                sections={sections}
                footer={footer}
                counts={counts}
                project={project}
                projects={projects}
                user={user}
                onSignOut={signOut}
                onNavigate={() => setDrawer(false)}
                headerSlot={
                  <RadixDialog.Close
                    aria-label="Close menu"
                    className="inline-flex size-10 items-center justify-center rounded-control text-side-fg hover:bg-side-hover hover:text-side-strong"
                  >
                    <X aria-hidden="true" className="size-5" />
                  </RadixDialog.Close>
                }
              />
            </RadixDialog.Content>
          </RadixDialog.Portal>
        </RadixDialog.Root>
      )}
      <ChatDrawer open={chat} onOpenChange={setChat} {...(project ? { projectId: project.id } : {})} />
    </Tooltip.Provider>
  );
}

function CollapseButtonLight({ onToggle }: { onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={false}
      aria-label="Expand menu"
      className="inline-flex size-9 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg"
    >
      <Menu aria-hidden="true" className="size-4" />
    </button>
  );
}
