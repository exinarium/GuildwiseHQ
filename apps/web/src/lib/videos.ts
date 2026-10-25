import { buildNav, isActive } from '../components/shell/nav-config.ts';

/**
 * The training videos: one Getting started video and one video per section of the sidebar (see
 * docs/guide/VIDEO-PLAN.md). The files are recorded by `e2e/video/<slug>.spec.ts` into `media/videos/<slug>.*`.
 *
 * Nothing links to a video that has not been recorded: every link (the Help article, the tour step and the "Watch the
 * video" button of the page help) goes through `publishedVideos`, which only lists entries marked `published`, and the
 * player itself shows nothing when the chapters JSON cannot be loaded. The recording task of a video flips its flag.
 */
export interface SectionVideoEntry {
  /** Shown above the player. */
  title: string;
  /**
   * The sidebar entry (its id in nav-config) the video explains; `platform` is the platform area; null for Getting started
   * and for the cross-cutting videos that have no sidebar entry of their own (they use `paths` and their Help anchor).
   */
  nav: string | null;
  /** Pages (a pathname prefix) whose page help offers this video, for a video that has no sidebar entry of its own. */
  paths?: string[];
  /** The Help article section the video is shown in: `slug#anchor`. */
  help: string;
  /** Set to true in the commit that adds the recorded files. */
  published: boolean;
}

export const GETTING_STARTED_SLUG = 'getting-started';

export const SECTION_VIDEOS: Record<string, SectionVideoEntry> = {
  [GETTING_STARTED_SLUG]: {
    title: 'Getting started with Guildwise HQ',
    nav: null,
    help: 'getting-started#training-video',
    published: true,
  },
  board: {
    title: 'The Board and your cards',
    nav: 'board',
    help: 'board-and-cards#reading-the-board',
    published: true,
  },
  backlog: {
    title: 'The project backlog',
    nav: 'backlog',
    help: 'board-and-cards#backlog',
    published: true,
  },
  environments: {
    title: 'Environments: where your app runs',
    nav: 'environments',
    help: 'phases#delivery-recipes',
    published: true,
  },
  research: {
    title: 'Research',
    nav: 'research',
    help: 'project-conversion#research-as-a-stage',
    published: true,
  },
  desk: { title: 'Your Desk', nav: 'desk', help: 'desk#desk-items', published: true },
  intake: {
    title: 'Intake: bring in tickets',
    nav: 'intake',
    help: 'intake-and-outbox#intake',
    published: true,
  },
  discovery: {
    title: 'Discovery: from an idea to a PRD',
    nav: 'discovery',
    help: 'discovery#start',
    published: true,
  },
  boardroom: {
    title: 'Boardroom: a debate with a Chair',
    nav: 'boardroom',
    help: 'boardroom#start',
    published: true,
  },
  capabilities: {
    title: 'Capabilities and packs',
    nav: 'capabilities',
    help: 'capabilities#packs',
    published: true,
  },
  automations: {
    title: 'Automations',
    nav: 'schedules',
    help: 'automations-and-integrations#triggers',
    published: true,
  },
  projects: {
    title: 'Projects and their settings',
    nav: 'projects',
    help: 'projects#ranking',
    published: true,
  },
  agents: { title: 'Your agents', nav: 'agents', help: 'agents#hiring', published: true },
  'org-chart': {
    title: 'The org chart',
    nav: 'org-chart',
    help: 'org-chart-and-design#org-chart',
    published: true,
  },
  ceo: { title: 'Your CEO', nav: 'ceo', help: 'your-ceo#talking', published: true },
  'roles-and-workflows': {
    title: 'Roles and workflows',
    nav: 'org',
    help: 'org-chart-and-design#custom-workflows',
    published: true,
  },
  workstations: {
    title: 'Workstations',
    nav: 'workstations',
    help: 'workstations-and-installer#add-a-workstation',
    published: true,
  },
  releases: { title: 'Releases', nav: 'releases', help: 'phases#releases', published: true },
  integrations: {
    title: 'Integrations',
    nav: 'integrations',
    help: 'integrations#connect',
    published: true,
  },
  metrics: { title: 'Metrics', nav: 'metrics', help: 'agents#hr-board', published: true },
  costs: {
    title: 'Costs and budgets',
    nav: 'costs',
    help: 'budgets-and-costs#monthly-budgets',
    published: true,
  },
  interests: {
    title: 'Interests',
    nav: 'interests',
    help: 'interests#run-and-delivery',
    published: true,
  },
  ledger: { title: 'The Ledger', nav: 'ledger', help: 'ledger-and-vaults#ledger', published: true },
  documents: {
    title: 'Documents',
    nav: 'documents',
    help: 'discovery#documents',
    published: true,
  },
  vaults: { title: 'Vaults', nav: 'vaults', help: 'ledger-and-vaults#vaults', published: true },
  settings: {
    title: 'Your settings',
    nav: 'settings',
    help: 'getting-started#your-settings',
    published: true,
  },
  organization: {
    title: 'Your organization',
    nav: 'organization',
    help: 'organizations-and-roles#members-and-invitations',
    published: true,
  },
  help: { title: 'The Help centre', nav: 'help', help: 'getting-started#the-sidebar', published: true },
  'ai-runtimes': {
    title: 'AI runtimes and model providers',
    nav: null,
    paths: ['/settings/providers'],
    help: 'ai-runtimes#accounts',
    published: true,
  },
  governance: {
    title: 'Governance: approvals, grants, audit and offboarding',
    nav: null,
    help: 'organizations-and-roles#audit-log',
    published: true,
  },
  'platform-area': {
    title: 'The platform area',
    nav: 'platform',
    help: 'organizations-and-roles#platform-area',
    published: true,
  },
};

/** Where the chapters JSON of a video is served from (the player reads everything else from it). */
export const videoInfoUrl = (slug: string): string => `/videos/${slug}.json`;

/** The registered, published video of a slug (or undefined: not registered, or not recorded yet). */
export function publishedVideo(slug: string): SectionVideoEntry | undefined {
  const e = SECTION_VIDEOS[slug];
  return e?.published ? e : undefined;
}

/** The published video that explains a sidebar entry (by its nav id), with its slug. */
export function videoForNav(nav: string): (SectionVideoEntry & { slug: string }) | undefined {
  for (const [slug, e] of Object.entries(SECTION_VIDEOS))
    if (e.published && e.nav === nav) return { ...e, slug };
  return undefined;
}

/** The published section videos shown in a Help article (`slug` of the article), each with the heading it follows. */
export function videosForArticle(
  article: string,
): Array<SectionVideoEntry & { slug: string; anchor: string }> {
  return Object.entries(SECTION_VIDEOS).flatMap(([slug, e]) => {
    const [a, anchor] = e.help.split('#');
    return e.published && slug !== GETTING_STARTED_SLUG && a === article && anchor
      ? [{ ...e, slug, anchor }]
      : [];
  });
}

/** The nav id of the sidebar section a page belongs to (the last matching entry is the most specific one). */
export function navIdForPath(pathname: string): string | null {
  if (pathname.startsWith('/platform')) return 'platform';
  const { sections, footer } = buildNav({
    projectKey: '_',
    hasResearch: true,
    hasEnvironments: true,
    canManage: true,
  });
  const all = [...sections.flatMap((s) => s.items), ...footer];
  let found: string | null = null;
  for (const e of all) if (isActive(e, pathname)) found = e.id;
  return found;
}

/** The published video of the page at `pathname`, if there is one. */
export function videoForPath(pathname: string): (SectionVideoEntry & { slug: string }) | undefined {
  for (const [slug, e] of Object.entries(SECTION_VIDEOS))
    if (e.published && e.paths?.some((p) => pathname === p || pathname.startsWith(`${p}/`)))
      return { ...e, slug };
  const nav = navIdForPath(pathname);
  return nav ? videoForNav(nav) : undefined;
}
