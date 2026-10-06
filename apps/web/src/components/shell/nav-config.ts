import {
  BookOpen,
  BriefcaseBusiness,
  ChartColumn,
  FolderKanban,
  Inbox,
  KanbanSquare,
  Lightbulb,
  type LucideIcon,
  Rss,
  Server,
  Settings,
  ShieldCheck,
  Timer,
  Users,
  Vault,
  Workflow,
} from 'lucide-react';

export interface NavEntry {
  /** Stable key (also the test-id suffix). */
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  /** Route predicate for the active state (default: pathname starts with `to`). */
  match?: (pathname: string) => boolean;
  testId?: string;
  adminOnly?: boolean;
}
export interface NavSection {
  label: string;
  items: NavEntry[];
}

/** The sidebar as data. Board points at the current project; Feed appears for feed projects (see `buildNav`). */
export function buildNav(opts: { projectKey: string | null; isFeed: boolean; isAdmin: boolean }): {
  sections: NavSection[];
  footer: NavEntry[];
} {
  const { projectKey, isFeed, isAdmin } = opts;
  const work: NavEntry[] = [
    {
      id: 'board',
      label: 'Board',
      to: projectKey ? `/p/${projectKey}/board` : '/projects',
      icon: KanbanSquare,
      match: (p) => p.startsWith('/p/') || p.startsWith('/cards/'),
    },
  ];
  if (isFeed && projectKey)
    work.push({
      id: 'feed',
      label: 'Feed',
      to: `/p/${projectKey}/feed`,
      icon: Rss,
      match: (p) => p.endsWith('/feed'),
    });
  work.push(
    { id: 'desk', label: 'Desk', to: '/desk', icon: Inbox },
    { id: 'intake', label: 'Intake', to: '/intake', icon: BriefcaseBusiness },
    { id: 'schedules', label: 'Schedules', to: '/schedules', icon: Timer },
    { id: 'projects', label: 'Projects', to: '/projects', icon: FolderKanban },
  );
  const sections: NavSection[] = [
    { label: 'Work', items: work },
    {
      label: 'Organization',
      items: [
        {
          id: 'agents',
          label: 'Agents',
          to: '/agents',
          icon: Users,
          match: (p) => p === '/agents' || p === '/hr',
        },
        { id: 'org', label: 'Roles & workflows', to: '/org', icon: Workflow },
        { id: 'workstations', label: 'Workstations', to: '/workstations', icon: Server },
        { id: 'metrics', label: 'Metrics', to: '/metrics', icon: ChartColumn },
      ],
    },
    {
      label: 'Knowledge',
      items: [
        { id: 'interests', label: 'Interests', to: '/interests', icon: Lightbulb, testId: 'nav-interests' },
        { id: 'ledger', label: 'Ledger', to: '/ledger', icon: BookOpen, testId: 'nav-ledger' },
        { id: 'vaults', label: 'Vaults', to: '/settings/vaults', icon: Vault, testId: 'nav-vaults' },
      ],
    },
  ];
  const footer: NavEntry[] = [
    { id: 'settings', label: 'Settings', to: '/settings', icon: Settings, match: (p) => p === '/settings' },
  ];
  if (isAdmin) footer.push({ id: 'admin', label: 'Admin', to: '/admin', icon: ShieldCheck, adminOnly: true });
  return { sections, footer };
}

export const isActive = (e: NavEntry, pathname: string): boolean =>
  e.match ? e.match(pathname) : pathname === e.to || pathname.startsWith(`${e.to}/`);
