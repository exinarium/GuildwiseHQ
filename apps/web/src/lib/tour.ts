import type { MeResponse } from '@aom/shared';

/** Which tour a user gets: the platform administrator's, or by the role in the organization of this tab. */
export type TourRole = 'platform' | 'manager' | 'member' | 'guest';

export const TOUR_ROLE_LABEL: Record<TourRole, string> = {
  platform: 'platform administrator',
  manager: 'Owner or Admin',
  member: 'Member',
  guest: 'Guest',
};

export function tourRoleOf(me: MeResponse | null | undefined): TourRole | null {
  if (!me) return null;
  if (me.account?.kind === 'super_admin') return 'platform';
  const role = me.activeOrg?.role;
  if (role === 'owner' || role === 'admin') return 'manager';
  if (role === 'member') return 'member';
  return 'guest';
}

export interface TourStep {
  id: string;
  /** The `data-tour` id of the element to light up. Without one the step is a card in the middle of the screen. */
  target?: string;
  /** Targets inside the sidebar: on a phone they live in the menu drawer, which the tour opens. */
  drawer?: boolean;
  title: string;
  body: string;
  /** Where to read more: `slug#anchor` of a help article (shown as "Read more"). */
  more?: string;
}

/** The sidebar entries of the app, in order, with what each is for. `nav` is the entry's id in nav-config. */
const NAV_STEPS: Record<string, { title: string; body: string; more?: string }> = {
  board: {
    title: 'Board',
    body: 'Every card of the current project, in columns that follow its workflow (for example Spec, In progress, Review, Done). Cards move by themselves as agents work: open one to see the plan, the transcript and what it cost. Use New card to hand out work.',
    more: 'board-and-cards#reading-the-board',
  },
  desk: {
    title: 'Desk',
    body: 'Your decision desk. When an agent needs an answer, an approval or a go-ahead it lands here, and the number shows how many are waiting (red when something is blocked). Answer once and the whole team moves on.',
    more: 'desk#desk-items',
  },
  intake: {
    title: 'Intake',
    body: 'Bring in tickets from Jira or GitHub. Guildwise HQ turns each one into a card with the details filled in, and asks you only about what is missing.',
    more: 'intake-and-outbox#intake',
  },
  projects: {
    title: 'Projects and phases',
    body: 'Each project has its own board, repository and settings, and the Projects page puts them in priority order: drag a project up to have your agents serve it first (the Owner and Admins can; everyone sees the order). Inside a project, phases group cards into a milestone: when the last card of a phase is done, a follow-up (such as a release check) can start by itself.',
    more: 'projects#ranking',
  },
  interests: {
    title: 'Interests',
    body: 'Topics you want an agent to keep an eye on, for example a competitor or a technology. Each interest has a schedule for when the agent looks and another for when you get the digest.',
    more: 'interests#run-and-delivery',
  },
  schedules: {
    title: 'Schedules',
    body: 'Work that starts by itself: every weekday morning, when a phase finishes, or when a ticket gets a label. Pick a trigger, then an action such as creating a card or sending a webhook.',
    more: 'schedules-and-integrations#triggers',
  },
  agents: {
    title: 'Agents',
    body: 'Your team. Hire an agent by role and seniority, choose which projects it may work on (its allow-list) and what it should focus on. Each one has a face, a track record and a cost.',
    more: 'agents#hiring',
  },
  'org-chart': {
    title: 'Org chart',
    body: 'The team drawn as a chart: each agent with its face, status and workstation, grouped by department and by who reports to whom. Filter it by project and click an agent for its card.',
    more: 'org-chart-and-design#org-chart',
  },
  workstations: {
    title: 'Workstations',
    body: 'The computers that run your agents. Nothing runs until you have one: click Add a workstation and the wizard gives you one command to paste, then shows its progress live.',
    more: 'workstations-and-installer#add-a-workstation',
  },
  costs: {
    title: 'Costs',
    body: 'What your agents spend, by project, agent and day, and the monthly budgets that stop spending when a limit is reached. Only Owners and Admins can change a budget.',
    more: 'budgets-and-costs#monthly-budgets',
  },
  ledger: {
    title: 'Ledger',
    body: 'The memory of your team: the requirements, decisions and standing orders agents rely on, searchable. Agents read it before they ask you, so you answer a question only once.',
    more: 'ledger-and-vaults#ledger',
  },
  vaults: {
    title: 'Vaults',
    body: 'Shared folders of notes and documents that sync to your workstations, so agents work from the same knowledge you do. Secrets stay on the machines you choose.',
    more: 'ledger-and-vaults#vaults',
  },
  settings: {
    title: 'Settings',
    body: 'Your own account: your picture, your time zone, when your daily report arrives and your two-factor login. Organization settings sit next to it.',
    more: 'getting-started#first-login',
  },
};

const navStep = (nav: keyof typeof NAV_STEPS & string): TourStep => {
  const s = NAV_STEPS[nav] as { title: string; body: string; more?: string };
  return { id: nav, target: `nav-${nav}`, drawer: true, ...s };
};

const WELCOME: TourStep = {
  id: 'welcome',
  title: 'Welcome to Guildwise HQ',
  body: 'You run a team of AI agents from here. This tour takes about two minutes and lights up each part of the screen as we go. You can skip it now and replay it any time from Help.',
  more: 'getting-started#the-tour',
};

const PALETTE: TourStep = {
  id: 'palette',
  target: 'palette',
  title: 'Search and jump anywhere',
  body: 'Press Ctrl K (Cmd K on a Mac) to find a card, an agent, a page or an action. Press ? to see every keyboard shortcut.',
  more: 'getting-started#command-palette',
};

const PAGE_HELP: TourStep = {
  id: 'page-help',
  target: 'page-help',
  title: 'What is on this page?',
  body: 'The help button in the top bar explains every control on the page you are looking at, without leaving it.',
  more: 'getting-started#page-help',
};

const HELP: TourStep = {
  id: 'help',
  target: 'nav-help',
  drawer: true,
  title: 'Help centre',
  body: 'Searchable articles, a glossary of the terms used here, this tour again, and a way to write to us. Small ? buttons next to the harder controls open the matching article.',
  more: 'getting-started#the-sidebar',
};

const DONE: TourStep = {
  id: 'done',
  title: 'You are set',
  body: 'That is the tour. Everything starts with a workstation to run your agents, then a project and an agent. Press ? at any time for the shortcuts, or open Help to replay this.',
};

const PLATFORM_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome, platform administrator',
    body: 'This is the platform area. You look after the organizations that use Guildwise HQ, not their work. This tour shows the five places you will use.',
    more: 'organizations-and-roles#platform-area',
  },
  {
    id: 'platform-orgs',
    target: 'platform-nav-orgs',
    title: 'Organizations',
    body: 'Every organization with its owner, plan and limits. Create one, suspend or reinstate it, and change its licence.',
    more: 'organizations-and-roles#suspension',
  },
  {
    id: 'platform-invitations',
    target: 'platform-nav-invitations',
    title: 'Invitations',
    body: 'Invite the Owner of a new organization. They get an email and set their own password.',
    more: 'organizations-and-roles#members-and-invitations',
  },
  {
    id: 'platform-users',
    target: 'platform-nav-users',
    title: 'Accounts',
    body: 'All accounts on the platform. Deactivate someone, reset their two-factor login, or see which organizations they belong to.',
  },
  {
    id: 'platform-support',
    target: 'platform-nav-support',
    title: 'Support',
    body: 'Messages from people using Contact us, with their organization and page attached. Answer by email from here and set the support address.',
    more: 'writing-to-us#contact-us',
  },
  {
    id: 'platform-audit',
    target: 'platform-nav-audit',
    title: 'Audit log',
    body: 'A record of every action taken in this area: who did what, to which organization, and when.',
  },
  { ...PAGE_HELP, id: 'page-help' },
  {
    id: 'platform-help',
    target: 'platform-help',
    title: 'Help',
    body: 'The articles, the glossary and this tour again. Press ? at any time for the keyboard shortcuts.',
  },
  {
    id: 'done',
    title: 'You are set',
    body: 'That is the platform area. Replay this tour from Help whenever you like.',
  },
];

/**
 * The steps for a role. `nav` is the set of sidebar entry ids this user actually has (a switched-off feature or a
 * role-limited page is not in it), so the tour never points at something that is not there.
 */
export function tourSteps(role: TourRole, nav: ReadonlySet<string>): TourStep[] {
  if (role === 'platform') return PLATFORM_STEPS;
  const only = (...ids: string[]): TourStep[] => ids.filter((i) => nav.has(i)).map(navStep);
  const common = [PALETTE, PAGE_HELP, HELP];
  switch (role) {
    case 'manager':
      return [
        WELCOME,
        ...only(
          'board',
          'desk',
          'intake',
          'projects',
          'interests',
          'schedules',
          'agents',
          'org-chart',
          'workstations',
          'costs',
          'ledger',
          'vaults',
          'settings',
        ),
        ...common,
        DONE,
      ];
    case 'member':
      return [
        WELCOME,
        ...only(
          'board',
          'desk',
          'projects',
          'interests',
          'schedules',
          'agents',
          'org-chart',
          'workstations',
          'ledger',
          'settings',
        ),
        ...common,
        DONE,
      ];
    case 'guest':
      return [
        {
          ...WELCOME,
          body: 'You have been invited to work on someone else’s project. This tour takes a minute and lights up the parts of the screen you will use. You can skip it now and replay it any time from Help.',
        },
        ...only('board', 'desk', 'workstations', 'interests', 'settings'),
        ...common,
        DONE,
      ];
  }
}

/** The step to show after the last one of the list when the user has no workstation yet. */
export const WORKSTATION_OFFER = {
  label: 'Add a workstation',
  to: '/workstations?add=1',
  text: 'You have no workstation yet, and agents need one to run. Add one now: the wizard installs everything for you.',
};
