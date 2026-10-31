import { isBusinessOrg, ORG_ROLE_LABEL } from '@aom/shared';
import * as RadixDialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ChevronLeft, CircleHelp, Menu, MessageSquare, Search, Wrench, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { matchPath, Outlet, useLocation, useNavigate } from 'react-router';
import { useLogout, useMe } from '../../api/queries/auth.ts';
import { useCard } from '../../api/queries/cards.ts';
import { useUnreadChatTotal } from '../../api/queries/chats.ts';
import { useDesk } from '../../api/queries/desk.ts';
import { BRAND } from '../../brand.ts';
import { useContact } from '../../extension/contact.tsx';
import { ext } from '../../extension/index.ts';
import { canUseIntake } from '../../lib/intake.ts';
import { setAppBadge } from '../../lib/pwa.ts';
import { useGlobalShortcuts } from '../../lib/shortcuts.ts';
import { useIsDesktop, useIsTabletUp } from '../../lib/useMediaQuery.ts';
import { getSocket, useSocketState } from '../../ws/socket.ts';
import { AgentFacesSync } from '../AgentFacesSync.tsx';
import { ChatDrawer } from '../ChatDrawer.tsx';
import { AskCeoButton } from '../ceo/AskCeoButton.tsx';
import { AskDevOpsProvider, useAskDevOps } from '../devops/AskDevOps.tsx';
import { PageHelpPanel } from '../help/PageHelpPanel.tsx';
import { CommandPalette } from '../palette/CommandPalette.tsx';
import { ShortcutsDialog } from '../palette/ShortcutsDialog.tsx';
import { PushPrompt } from '../push/PushPrompt.tsx';
import { SetupChecklistProvider, SetupWidget } from '../setup/SetupChecklist.tsx';
import { TourProvider } from '../tour/Tour.tsx';
import { useTour } from '../tour/TourContext.tsx';
import { cx } from '../ui/cx.ts';
import { WhatsNewHost } from '../whatsnew/WhatsNew.tsx';
import { Breadcrumbs, crumbsFor } from './Breadcrumbs.tsx';
import { MobileTabBar, UnreadBadge } from './MobileTabBar.tsx';
import { buildNav } from './nav-config.ts';
import { OrgBanner } from './OrgBanner.tsx';
import { OrgSwitcher } from './OrgSwitcher.tsx';
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

/** Where "back" goes on a phone: the parent crumb, or the list a detail page belongs to. Null on top-level pages. */
export function backTargetFor(
  pathname: string,
  crumbs: Array<{ label: string; to?: string }>,
): string | null {
  const parent = crumbs.length > 1 ? crumbs.at(-2)?.to : undefined;
  if (parent) return parent;
  if (pathname.startsWith('/chat/') || pathname.startsWith('/ceo-chat')) return '/desk';
  if (pathname.startsWith('/intake/')) return '/intake';
  if (pathname.startsWith('/help/')) return '/help';
  if (pathname === '/settings/org' || pathname === '/settings/vaults') return '/settings';
  if (pathname.startsWith('/interests/')) return '/interests';
  if (pathname.startsWith('/workstations/')) return '/workstations';
  return null;
}

/** The extension's providers (the hosted build's Contact us dialog), or nothing. */
function AppProviders({ children }: { children: ReactNode }) {
  return ext.AppProviders ? <ext.AppProviders>{children}</ext.AppProviders> : <>{children}</>;
}

/** The signed-in application frame: dark sidebar (rail on tablets, drawer on phones), top bar, `main`. */
export function AppShell({ name, live }: { name: string; live: string }) {
  return (
    <AppProviders>
      <AskDevOpsProvider>
        <Shell name={name} live={live} />
      </AskDevOpsProvider>
    </AppProviders>
  );
}

function Shell({ name, live }: { name: string; live: string }) {
  const contact = useContact();
  const askDevOps = useAskDevOps();
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
  const unreadChats = useUnreadChatTotal();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [pageHelp, setPageHelp] = useState(false);
  const [tourOn, setTourOn] = useState(false);
  const navigate = useNavigate();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  const counts = { open: desk.data?.counts.open ?? 0, blocking: desk.data?.counts.blocking ?? 0 };
  const org = me.data?.activeOrg ?? null;
  const canManage = org?.role === 'owner' || org?.role === 'admin';
  const { sections, footer } = buildNav({
    projectKey: project?.key ?? null,
    hasEnvironments: !!project && project.workflowKey !== 'research',
    hasResearch:
      !!project &&
      ((project.publishedNotes ?? 0) > 0 || (project.startedAs ?? project.workflowKey) === 'research'),
    canManage,
    features: org?.features ?? {},
    business: isBusinessOrg(org),
  });
  const intakeOn = canUseIntake(org);
  const intake = intakeOn
    ? { to: '/intake', label: 'Intake' }
    : { to: project ? `/cards/new?project=${project.key}` : '/cards/new', label: 'New' };
  const roleLabel = org ? ORG_ROLE_LABEL[org.role] : 'Member';
  const orgSlot = me.data ? <OrgSwitcher me={me.data} collapsed={false} /> : null;
  const orgSlotCollapsed = me.data ? <OrgSwitcher me={me.data} collapsed /> : null;
  const collapsed = isTabletUp && (!isDesktop || pref);
  const user = {
    id: me.data?.user.id,
    name,
    email: me.data?.user.email ?? '',
    roleLabel,
    avatar: me.data?.user.avatar ?? null,
  };
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

  useGlobalShortcuts({
    palette: () => setPalette((o) => !o),
    help: () => setHelp(true),
    newCard: () => navigate(project ? `/cards/new?project=${project.key}` : '/cards/new'),
    search: () => {
      const box = document.querySelector<HTMLInputElement>('main input[type="search"]');
      if (box) {
        box.focus();
        box.select();
      } else setPalette(true);
    },
    go: (page) =>
      navigate(
        {
          board: project ? `/p/${project.key}/board` : '/projects',
          desk: '/desk',
          agents: '/agents',
          projects: '/projects',
          workstations: '/workstations',
          interests: '/interests',
        }[page],
      ),
  });

  // The number on the home-screen icon follows the open desk items (where the browser supports it).
  const deskOpen = counts.open;
  useEffect(() => {
    if (desk.data) setAppBadge(deskOpen);
  }, [desk.data, deskOpen]);

  const navIds = new Set([...sections.flatMap((s) => s.items), ...footer].map((e) => e.id));
  const cardParam = matchPath('/cards/:ref', pathname)?.params.ref;
  const shownCard = useCard(cardParam && cardParam !== 'new' ? cardParam : undefined);
  const shownCardRef = shownCard.data?.card;
  const crumbs = crumbsFor(pathname, search, projects, shownCardRef);
  const pageName = crumbs.at(-1)?.label ?? BRAND.name;
  const backTo = backTargetFor(pathname, crumbs);

  return (
    <SetupChecklistProvider>
      <TourProvider navIds={navIds} mobile={!isTabletUp} onDrawer={setDrawer} onActive={setTourOn}>
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
                  orgSlot={collapsed ? orgSlotCollapsed : orgSlot}
                  setupSlot={<SetupWidget collapsed={collapsed} />}
                  headerSlot={
                    isDesktop && !collapsed ? (
                      <CollapseButton collapsed={false} onToggle={toggle} />
                    ) : undefined
                  }
                />
              </aside>
            )}

            <div className="flex min-h-dvh min-w-0 flex-col">
              {isTabletUp ? (
                <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-line bg-canvas/85 px-6 backdrop-blur lg:px-8">
                  <div className="flex min-w-0 items-center gap-3">
                    {isDesktop && collapsed && <CollapseButtonLight onToggle={toggle} />}
                    <Breadcrumbs projects={projects} card={shownCardRef} />
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    <LiveIndicator live={live} />
                    <button
                      type="button"
                      onClick={() => setPalette(true)}
                      aria-label="Search and jump to (Ctrl K)"
                      data-testid="palette-button"
                      data-tour="palette"
                      className="inline-flex h-9 items-center gap-2 rounded-control border border-control bg-surface px-3 text-sm text-muted hover:bg-sunken"
                    >
                      <Search aria-hidden="true" className="size-4" />
                      <span className="hidden xl:inline">Search</span>
                      <kbd className="hidden rounded-[6px] border border-control bg-sunken px-1.5 font-mono text-xs text-subtle lg:inline">
                        Ctrl K
                      </kbd>
                    </button>
                    <PageHelpButton onClick={() => setPageHelp(true)} />
                    {!isBusinessOrg(org) && (
                      <button
                        type="button"
                        onClick={() => askDevOps()}
                        aria-label="Ask DevOps"
                        data-testid="ask-devops-button"
                        data-tour="ask-devops"
                        className="inline-flex h-9 items-center gap-2 rounded-control border border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-sunken"
                      >
                        <Wrench aria-hidden="true" className="size-4" />
                        <span className="hidden xl:inline">Ask DevOps</span>
                      </button>
                    )}
                    <AskCeoButton />
                    <button
                      type="button"
                      onClick={() => setChat(true)}
                      aria-label="Chat with an agent"
                      className="inline-flex h-9 items-center gap-2 rounded-control border border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-sunken"
                    >
                      <span className="relative inline-flex">
                        <MessageSquare aria-hidden="true" className="size-4" />
                        <UnreadBadge count={unreadChats} testId="chat-button-badge" className="-ml-2" />
                      </span>
                      Chat
                    </button>
                  </div>
                </header>
              ) : (
                <header
                  data-testid="mobile-topbar"
                  className="sticky top-0 z-20 flex min-h-14 items-center gap-1 border-b border-line bg-canvas/90 pr-2 pl-[max(0.5rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] backdrop-blur"
                >
                  {backTo ? (
                    <button
                      type="button"
                      onClick={() => navigate(backTo)}
                      aria-label="Back"
                      data-testid="mobile-back"
                      className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-fg hover:bg-sunken"
                    >
                      <ChevronLeft aria-hidden="true" className="size-6" />
                    </button>
                  ) : (
                    <span aria-hidden="true" className="w-2 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1 px-1">
                    <p className="truncate text-base font-semibold text-fg" data-testid="mobile-title">
                      {pageName}
                    </p>
                    {project && <p className="truncate text-xs text-subtle">{project.name}</p>}
                  </div>
                  {!pathname.startsWith('/ceo-chat') && <AskCeoButton mobile />}
                  <PageHelpButton onClick={() => setPageHelp(true)} mobile />
                  <span className="pr-2 pl-1">
                    <LiveIndicator live={live} compact />
                  </span>
                </header>
              )}
              <main id="main" ref={main} tabIndex={-1} className="mx-auto w-full min-w-0 flex-1 outline-none">
                {me.data && <OrgBanner me={me.data} project={project} />}
                <div className="px-4 py-5 pb-[calc(1.25rem+var(--app-bottom-inset,0px))] sm:px-6 sm:py-6 sm:pb-[calc(1.5rem+var(--app-bottom-inset,0px))] lg:px-8">
                  <Outlet />
                </div>
              </main>
            </div>
          </div>

          {!isTabletUp && (
            <RadixDialog.Root open={drawer} onOpenChange={setDrawer} modal={!tourOn}>
              <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-40 animate-fade bg-overlay" />
                <RadixDialog.Content
                  aria-label="Main menu"
                  aria-describedby={undefined}
                  onInteractOutside={tourOn ? (e) => e.preventDefault() : undefined}
                  className="fixed inset-0 z-50 animate-fade bg-side pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
                >
                  <RadixDialog.Title className="sr-only">Main menu</RadixDialog.Title>
                  <SidebarBody
                    flowing
                    sections={sections}
                    footer={footer}
                    counts={counts}
                    project={project}
                    projects={projects}
                    user={user}
                    onSignOut={signOut}
                    onNavigate={() => setDrawer(false)}
                    orgSlot={
                      me.data ? <OrgSwitcher me={me.data} onNavigate={() => setDrawer(false)} /> : null
                    }
                    setupSlot={<SetupWidget />}
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
          {!isTabletUp && (
            <MobileTabBar
              counts={counts}
              intake={intake}
              chatsOpen={chat}
              moreOpen={drawer}
              onChats={() => {
                setDrawer(false);
                setChat(true);
              }}
              onMore={() => setDrawer(true)}
            />
          )}
          <AgentFacesSync />
          <CommandPalette
            open={palette}
            onOpenChange={setPalette}
            ctx={{
              sections,
              footer,
              projects,
              projectKey: project?.key ?? null,
              onChat: () => setChat(true),
              ...(isBusinessOrg(org) ? {} : { onAskDevOps: () => askDevOps() }),
              onHelp: () => setHelp(true),
              ...(contact.available ? { onContact: () => contact.open() } : {}),
              onPageHelp: () => setPageHelp(true),
            }}
          />
          <PageHelpPanel open={pageHelp} onOpenChange={setPageHelp} />
          <WhatsNewHost />
          <PushPrompt />
          <ShortcutsDialog open={help} onOpenChange={setHelp} />
          <ChatDrawer open={chat} onOpenChange={setChat} {...(project ? { projectId: project.id } : {})} />
        </Tooltip.Provider>
      </TourProvider>
    </SetupChecklistProvider>
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

/** The "?" of the top bar: opens "What is on this page" for the page behind it. */
function PageHelpButton({ onClick, mobile = false }: { onClick: () => void; mobile?: boolean }) {
  const tour = useTour();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="What is on this page"
      data-testid="page-help-button"
      data-tour="page-help"
      data-tour-active={tour.active || undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg',
        mobile ? 'size-11 text-fg' : 'size-9 border border-control bg-surface',
      )}
    >
      <CircleHelp aria-hidden="true" className="size-5" />
    </button>
  );
}
