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
  /** The getting-started video player is shown inside the card (text only when there is no video file). */
  video?: boolean;
  /** The nav id whose section video the card shows, when it is not the step's own id (only once published). */
  videoNav?: string;
  /** The label of the Next button, when it is not "Next". */
  nextLabel?: string;
}

/** The sidebar entries of the app, in order, with what each is for. `nav` is the entry's id in nav-config. */
const NAV_STEPS: Record<string, { title: string; body: string; more?: string }> = {
  board: {
    title: 'Board',
    body: 'Every card of the current project, in columns that follow its workflow (for example Spec, In progress, Review, Done). Cards move by themselves as agents work: open one to see the plan, the transcript and what it cost. Use New card to hand out work.',
    more: 'board-and-cards#reading-the-board',
  },
  backlog: {
    title: 'Backlog',
    body: 'Ideas and suggestions waiting to become cards, kept per project. Everyone on the project can read it; Owners and Admins add, edit and use Send to the BA to turn the ones they pick into cards.',
    more: 'board-and-cards#backlog',
  },
  environments: {
    title: 'Environments',
    body: 'Where the project’s app runs: your app, its test copies, environments and places, and the Releases switch that pauses or resumes going live.',
    more: 'phases#delivery-recipes',
  },
  research: {
    title: 'Research',
    body: 'Research cards that are in progress and the notes that have been published for this project.',
    more: 'project-conversion#research-as-a-stage',
  },
  desk: {
    title: 'Desk',
    body: 'Your decision desk. When an agent needs an answer, an approval or a go-ahead it lands here, and the number shows how many are waiting (red when something is blocked). Answer once and the whole team moves on.',
    more: 'desk#desk-items',
  },
  intake: {
    title: 'Intake',
    body: 'Bring in tickets from Jira or GitHub, one at a time in a chat or many at once on the Batch tab. Guildwise HQ turns each one into a card with the details filled in and asks you only about what is missing; the Owner can also hand a ticket to the CEO with Tell your CEO.',
    more: 'intake-and-outbox#intake',
  },
  discovery: {
    title: 'Discovery',
    body: 'Turn an idea into a brief or a PRD. An analyst interviews you one question at a time, keeps ideas, assumptions and decisions in a side panel, and drafts the document with you; your CEO can join. Approve the PRD and hand it to the BA to get cards.',
    more: 'discovery#start',
  },
  boardroom: {
    title: 'Boardroom',
    body: 'Put a question to a group of personas and agents. Everyone answers on their own first and the answers are revealed together; then a Chair picks who speaks next, records disagreements and stops when it needs your decision. Interject or @mention a seat at any time, keep a whiteboard of ideas and risks, and pull the minutes into a PRD.',
    more: 'boardroom#start',
  },
  projects: {
    title: 'Projects and phases',
    body: 'Each project has its own board, repositories and settings, and the Projects page puts them in priority order: drag a project up to have your agents serve it first (the Owner and Admins can; everyone sees the order). Inside a project, phases group cards into a milestone: when the last card of a phase is done, you approve the follow-ups (such as a deploy and a regression run) and they run in order.',
    more: 'projects#ranking',
  },
  interests: {
    title: 'Interests',
    body: 'Topics you want an agent to keep an eye on, for example a competitor or a technology. Each interest has a schedule for when the agent looks and another for when you get the digest.',
    more: 'interests#run-and-delivery',
  },
  schedules: {
    title: 'Automations',
    body: 'Work that starts by itself: every weekday morning, when a phase finishes, when a card reaches a stage, or when a ticket gets a label. Pick a trigger, then an action such as creating a card or sending a webhook.',
    more: 'automations-and-integrations#triggers',
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
  ceo: {
    title: 'CEO',
    body: 'Your CEO, with tabs for Overview, Authority, Reporting & alerts, Persona & instructions, Memory, Tasks, Topics, Activity log and Workstations. It handles routine desk items before they reach you; use Ask followed by its name to chat with it.',
    more: 'your-ceo#talking',
  },
  org: {
    title: 'Roles & workflows',
    body: 'The page is titled Organization. It has the Roles your agents fill, the Workflows cards follow, Departments, and Design with the BA to reshape them in a chat.',
    more: 'org-chart-and-design#custom-workflows',
  },
  workstations: {
    title: 'Workstations',
    body: 'The machines that run your agents: your own computer, a server (VPS) or a GitHub Codespace. Nothing runs until you have one: click Add a workstation and the wizard sets it up and shows its progress live.',
    more: 'workstations-and-installer#add-a-workstation',
  },
  releases: {
    title: 'Releases',
    body: 'What is waiting to go live, what is live now, the history, and the rule that decides when changes are released, including Freeze all releases.',
    more: 'phases#releases',
  },
  integrations: {
    title: 'Integrations',
    body: 'Sign in Claude (one tile per account), connect git hosts and Jira, and add MCP servers, per workstation.',
    more: 'integrations#connect',
  },
  metrics: {
    title: 'Metrics',
    body: 'How the work flows: throughput, time blocked on you, bounce rate per builder, bugs escaped past test, durations and queue depth per column. Pick a project and a range of 7 to 90 days.',
    more: 'agents#hr-board',
  },
  costs: {
    title: 'Costs',
    body: 'What your agents spend, by project, agent, model and day. Monthly budgets are set in each project’s settings and the Costs page shows how much of each is used. Only Owners and Admins see this page.',
    more: 'budgets-and-costs#monthly-budgets',
  },
  documents: {
    title: 'Documents',
    body: 'Briefs and PRDs from your discovery sessions, with their versions and status. Approved ones are copied to your vault.',
    more: 'discovery#documents',
  },
  ledger: {
    title: 'Ledger',
    body: 'The memory of your team: the requirements, decisions and standing orders agents rely on, searchable. Agents read it before they ask you, so you answer a question only once.',
    more: 'ledger-and-vaults#ledger',
  },
  vaults: {
    title: 'Vaults',
    body: 'Folders of notes and documents that agents read. A git vault syncs to your workstations, and a project vault can also be a local folder, so agents work from the same knowledge you do.',
    more: 'ledger-and-vaults#vaults',
  },
  settings: {
    title: 'Settings',
    body: 'Your own account: your picture, your time zone, Notifications, the Monday briefing, your two-factor login, the weekly blog digest and expert mode for code changes (off by default, so you never need git). The time of the daily report is set on the CEO’s Reporting & alerts tab.',
    more: 'getting-started#your-settings',
  },
  organization: {
    title: 'Organization',
    body: 'Members, invitations, guests, the e-mail inbox, project links, plan and billing of the whole organization.',
    more: 'organizations-and-roles#members-and-invitations',
  },
};

/** The tour walks the sidebar top to bottom. Entries the user does not have are filtered out by `navIds`. */
const SIDEBAR_ORDER = [
  'board',
  'backlog',
  'environments',
  'research',
  'desk',
  'intake',
  'discovery',
  'boardroom',
  'schedules',
  'projects',
  'agents',
  'org-chart',
  'ceo',
  'org',
  'workstations',
  'releases',
  'integrations',
  'metrics',
  'costs',
  'interests',
  'ledger',
  'documents',
  'vaults',
  'settings',
  'organization',
];

const navStep = (nav: keyof typeof NAV_STEPS & string): TourStep => {
  const s = NAV_STEPS[nav] as { title: string; body: string; more?: string };
  return { id: nav, target: `nav-${nav}`, drawer: true, ...s };
};

/** The first step of the work tour: the 3-minute training video, then the tour itself. */
const VIDEO: TourStep = {
  id: 'video',
  title: 'Watch the 3-minute getting-started video',
  body: 'A short voice-over goes from an empty organization to a team at work: the Get started checklist, a workstation, a project and its repository, a lean team, a first card and a talk with the business analyst, an answer on the Desk, and the board moving by itself. Watch it now, or any time from Help, then take the tour.',
  more: 'getting-started#training-video',
  video: true,
  nextLabel: 'Next: take the tour',
};

const WELCOME: TourStep = {
  id: 'welcome',
  title: 'Welcome to Guildwise HQ',
  body: 'You run a team of AI agents from here. This tour takes about three minutes and lights up each part of the screen as we go. You can skip it now and replay it any time from Help.',
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

const ASK_DEVOPS: TourStep = {
  id: 'ask-devops',
  target: 'ask-devops',
  title: 'Ask DevOps',
  body: 'Each workstation has a DevOps engineer that installs tools, fixes setup problems and runs commands for you. Your CEO passes your request on (the dialog says it works through the CEO now), so the button is Ask followed by your CEO’s name. Ask from here, from a card, a desk item or a workstation: what you are looking at is attached.',
  more: 'devops-and-hygiene#devops-engineer',
};

const HELP: TourStep = {
  id: 'help',
  target: 'nav-help',
  drawer: true,
  title: 'Help centre',
  body: 'A short training video, searchable articles, a glossary of the terms used here, the Blog, what is new, this tour again, and a way to write to us, with My requests to follow your messages. Small ? buttons next to the harder controls open the matching article.',
  more: 'getting-started#the-sidebar',
};

const DONE: TourStep = {
  id: 'done',
  title: 'You are set',
  body: 'That is the tour. While your organization is being set up, the Get started button at the bottom of the sidebar lists what is left (project, repository, workstation, team, business analyst) and ticks each step off by itself. Press ? at any time for the shortcuts, or open Help to replay this.',
};

const PLATFORM_STEPS: TourStep[] = [
  {
    id: 'welcome',
    videoNav: 'platform',
    title: 'Welcome, platform administrator',
    body: 'This is the platform area. You look after the organizations that use Guildwise HQ, not their work. This tour shows the places you will use.',
    more: 'organizations-and-roles#platform-area',
  },
  {
    id: 'platform-orgs',
    target: 'platform-nav-orgs',
    title: 'Organizations',
    body: 'Every organization with its owner, plan and limits. Open one to suspend or reinstate it, change its limits, see its billing, or give it the Unlimited plan.',
    more: 'organizations-and-roles#suspension',
  },
  {
    id: 'platform-invitations',
    target: 'platform-nav-invitations',
    title: 'Invitations',
    body: 'Invite the Owner of a new organization (others sign up themselves on the website). They get an email and set their own password.',
    more: 'organizations-and-roles#members-and-invitations',
  },
  {
    id: 'platform-users',
    target: 'platform-nav-users',
    title: 'Accounts',
    body: 'All accounts on the platform. Deactivate someone, reset their two-factor login, send a password reset link, or see which organizations they belong to.',
  },
  {
    id: 'platform-billing',
    target: 'platform-nav-billing',
    title: 'Billing',
    body: 'The plans, their prices and limits, the Business add-on prices, VAT and the exchange rate. Every change needs a reason and is audited.',
    more: 'billing-and-plans#platform',
  },
  {
    id: 'platform-support',
    target: 'platform-nav-support',
    title: 'Support',
    body: 'Messages from people using Contact us, with their organization and page attached. Answer from here, set the address that gets them by email, and switch the landing-page assistant on or off.',
    more: 'organizations-and-roles#console-emails',
  },
  {
    id: 'platform-blog',
    target: 'platform-nav-blog',
    title: 'Blog',
    body: 'The blog writer (switch it on, set topics and a monthly cap), the review queue for its articles, the weekly digest, social sharing and the switch that turns the blog off.',
    more: 'blog-and-digest#platform-blog',
  },
  {
    id: 'platform-api-keys',
    target: 'platform-nav-api-keys',
    title: 'API keys',
    body: 'Keys that let outside tools use the platform API (/api/v1). Create one, copy it once, and revoke it when it is no longer needed.',
    more: 'organizations-and-roles#platform-area',
  },
  {
    id: 'platform-runners',
    target: 'platform-nav-runners',
    title: 'Runners',
    body: 'Runners check this server once a day and update themselves. Here you can pause the automatic updates and see when they are not happening.',
    more: 'organizations-and-roles#platform-area',
  },
  {
    id: 'platform-team',
    target: 'platform-nav-team',
    title: 'Platform team',
    body: 'Which organization and project receive the platform’s own bugs and reports. Approvals go to that organization’s desk, not to you.',
    more: 'organizations-and-roles#platform-area',
  },
  {
    id: 'platform-inbound',
    target: 'platform-nav-inbound',
    title: 'Inbound mail',
    body: 'Whether inbound e-mail is set up, and how many messages were accepted or skipped in the last 24 hours.',
    more: 'organizations-and-roles#platform-area',
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
  const common = [PALETTE, PAGE_HELP, ASK_DEVOPS, HELP];
  switch (role) {
    case 'manager':
      return [VIDEO, WELCOME, ...only(...SIDEBAR_ORDER), ...common, DONE];
    case 'member':
      return [VIDEO, WELCOME, ...only(...SIDEBAR_ORDER), ...common, DONE];
    case 'guest':
      return [
        VIDEO,
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
