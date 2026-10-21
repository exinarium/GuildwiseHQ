import {
  BookOpen,
  BookOpenText,
  BriefcaseBusiness,
  Building2,
  ChartColumn,
  Cloud,
  Coins,
  FolderKanban,
  Inbox,
  KanbanSquare,
  LifeBuoy,
  Lightbulb,
  type LucideIcon,
  Network,
  Plug,
  Rocket,
  Server,
  Settings,
  Timer,
  UserCog,
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
  /** Hidden for roles below Owner/Admin (the server enforces it regardless). */
  managerOnly?: boolean;
}
export interface NavSection {
  label: string;
  items: NavEntry[];
}

/** The sidebar as data. Board points at the current project; Interests live under Knowledge. */
export function buildNav(opts: {
  projectKey: string | null;
  /** The current project has published research notes or started as research: it gets a Research entry. */
  hasResearch?: boolean;
  /** The current project delivers code (it has an Environments page: where its app runs). */
  hasEnvironments?: boolean;
  /** Owner or Admin of the active organization. */
  canManage?: boolean;
  /** Feature flags of the active organization (a switched-off feature leaves the nav; its data is kept). */
  features?: Record<string, boolean>;
  /** A platform account has no work nav at all. */
  platform?: boolean;
}): {
  sections: NavSection[];
  footer: NavEntry[];
} {
  const { projectKey, hasResearch = false, hasEnvironments = false, canManage = false, features = {} } = opts;
  const on = (f: string) => features[f] !== false;
  const work: NavEntry[] = [
    {
      id: 'board',
      label: 'Board',
      to: projectKey ? `/p/${projectKey}/board` : '/projects',
      icon: KanbanSquare,
      match: (p) => p.startsWith('/p/') || p.startsWith('/cards/'),
    },
  ];
  if (projectKey && hasEnvironments)
    work.push({
      id: 'environments',
      label: 'Environments',
      to: `/p/${projectKey}/environments`,
      icon: Cloud,
      testId: 'nav-environments',
      match: (p) => p.endsWith('/environments'),
    });
  if (hasResearch && projectKey)
    work.push({
      id: 'research',
      label: 'Research',
      to: `/p/${projectKey}/research`,
      icon: BookOpenText,
      testId: 'nav-research',
      match: (p) => p.endsWith('/research'),
    });
  work.push({ id: 'desk', label: 'Desk', to: '/desk', icon: Inbox });
  if (on('integrations') && canManage)
    work.push({ id: 'intake', label: 'Intake', to: '/intake', icon: BriefcaseBusiness });
  work.push(
    { id: 'schedules', label: 'Automations', to: '/automations', icon: Timer },
    { id: 'projects', label: 'Projects', to: '/projects', icon: FolderKanban },
  );
  const knowledge: NavEntry[] = [];
  if (on('interests'))
    knowledge.push({
      id: 'interests',
      label: 'Interests',
      to: '/interests',
      icon: Lightbulb,
      testId: 'nav-interests',
    });
  knowledge.push({ id: 'ledger', label: 'Ledger', to: '/ledger', icon: BookOpen, testId: 'nav-ledger' });
  if (canManage)
    knowledge.push({
      id: 'vaults',
      label: 'Vaults',
      to: '/settings/vaults',
      icon: Vault,
      testId: 'nav-vaults',
    });
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
        { id: 'org-chart', label: 'Org chart', to: '/org-chart', icon: Network, testId: 'nav-org-chart' },
        ...(canManage ? [{ id: 'ceo', label: 'CEO', to: '/org/ceo', icon: UserCog, testId: 'nav-ceo' }] : []),
        {
          id: 'org',
          label: 'Roles & workflows',
          to: '/org',
          icon: Workflow,
          match: (p) => p === '/org' || p.startsWith('/org/workflows'),
        },
        { id: 'workstations', label: 'Workstations', to: '/workstations', icon: Server },
        { id: 'releases', label: 'Releases', to: '/releases', icon: Rocket, testId: 'nav-releases' },
        {
          id: 'integrations',
          label: 'Integrations',
          to: '/integrations',
          icon: Plug,
          match: (p) => p.startsWith('/integrations') || /^\/workstations\/[^/]+\/integrations/.test(p),
          testId: 'nav-integrations',
        },
        { id: 'metrics', label: 'Metrics', to: '/metrics', icon: ChartColumn },
        ...(canManage
          ? [{ id: 'costs', label: 'Costs', to: '/costs', icon: Coins, testId: 'nav-costs' }]
          : []),
      ],
    },
    { label: 'Knowledge', items: knowledge },
  ];
  const footer: NavEntry[] = [
    { id: 'settings', label: 'Settings', to: '/settings', icon: Settings, match: (p) => p === '/settings' },
    {
      id: 'organization',
      label: 'Organization',
      to: '/settings/org',
      icon: Building2,
      testId: 'nav-organization',
    },
    { id: 'help', label: 'Help', to: '/help', icon: LifeBuoy, testId: 'nav-help' },
  ];
  return { sections, footer };
}

export const isActive = (e: NavEntry, pathname: string): boolean =>
  e.match ? e.match(pathname) : pathname === e.to || pathname.startsWith(`${e.to}/`);
