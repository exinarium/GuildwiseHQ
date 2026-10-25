import type { Cue, NarratedChapter } from './types.ts';

/**
 * The voice-over of the Overview video (slug `overview`, about twelve minutes) and of the 55-second teaser (slug
 * `overview-teaser`). The words are those of video/overview-script.md, split into passages that follow the screens.
 * `text` is what the captions show; the voice reads `speech`, which spells the product name as the script asks.
 */
const say = (id: string, text: string): Cue => ({
  id,
  text,
  speech: text.replaceAll('Guildwise HQ', 'Guildwise H Q').replaceAll('Apache 2.0', 'Apache two point oh'),
});

export const INTRO: Cue[] = [
  say(
    'intro-1',
    'Welcome to Guildwise HQ. This video is a short tour of the whole product, at a high level. It takes about twelve minutes.',
  ),
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Welcome',
    banner: 'Welcome',
    cues: [
      say(
        'c1-a',
        'Guildwise HQ lets you run an organization of AI agents. You hire agents into roles, give them work on a board, and keep every decision that matters.',
      ),
      say(
        'c1-b',
        'It comes set up for software delivery. You describe what you want, in plain words. A team of agents turns it into a clear specification, builds it on a branch of your code, has another agent review it, and tests it. The same organization can also run other work, like research and scheduled digests, and you can shape its roles and workflows to fit.',
      ),
      say(
        'c1-c',
        'You stay in charge. The agents ask you when they need a decision, and they wait for your go-ahead before anything risky.',
      ),
      say('c1-d', 'Let’s start with the idea.'),
    ],
  },
  {
    title: 'A team of agents, not a chatbot',
    banner: 'A team of agents, not a chatbot',
    cues: [
      say(
        'c2-a',
        'Think of it as hiring a small team. In the default software setup, someone writes the specification. Someone builds. Someone reviews the work and tries to break it. Someone tests it. And an assistant keeps notes and reports to you.',
      ),
      say(
        'c2-b',
        'Each member has a role, a level of seniority, and a name. They work on the projects you allow them to work on, and they can only take work from those projects.',
      ),
      say(
        'c2-c',
        'They are not guessing in the dark. Every decision the team makes is recorded, so the team does not ask you the same thing twice.',
      ),
      say(
        'c2-d',
        'The team is made of AI agents, and the AI behind them is Claude, from Anthropic. You sign in to Claude once on the computer where the agents run.',
      ),
    ],
  },
  {
    title: 'Your organization and who does what',
    banner: 'Your organization',
    cues: [
      say(
        'c3-a',
        'Everything lives inside an organization. It holds the people, the projects, the agents, the workstations and the records.',
      ),
      say(
        'c3-b',
        'There are four roles. Owners and Admins manage the organization. Members do the work in the projects they were added to. Guests are visitors from another organization, who can work in one shared project.',
      ),
      say(
        'c3-c',
        'The platform administrator runs the service. That person can see organizations, but never anyone’s work.',
      ),
    ],
  },
  {
    title: 'The board: how a card travels',
    banner: 'The board',
    cues: [
      say(
        'c4-a',
        'A piece of work is a card. You create one with New card, and you write what you want, in your own words. The default software workflow is what you see here. Research and feed projects use their own, simpler workflows, and you can design your own.',
      ),
      say(
        'c4-b',
        'The card then moves across the board by itself. First it is specified: the context, the requirements, and what done looks like. Then a builder works on a branch of your repository. A reviewer reads the change, and sends it back when it is not right.',
      ),
      say(
        'c4-c',
        'A tester runs the tests. If a test fails, the problem becomes a bug card, and the original waits for the fix. At the end, the work is finalized the way your project says: committed to a branch, or proposed as a pull request for you to approve. Where the project asks for it, you do a quick check yourself before the card is done.',
      ),
      say(
        'c4-d',
        'The filters help you see what needs you. Blocked shows the cards that are stuck. Waiting for my approval shows the cards that need your go-ahead.',
      ),
      say(
        'c4-e',
        'Open a card, and you see its brief, the conversation, each run of an agent, and what it cost.',
      ),
    ],
  },
  {
    title: 'Your desk: decisions only you can make',
    banner: 'Your desk',
    cues: [
      say(
        'c5-a',
        'Your desk is your inbox of decisions. It holds the questions, the approvals and the go-aheads that only you can give.',
      ),
      say(
        'c5-b',
        'When an agent is unsure, it asks you here, and it carries on once you answer. When something is risky, such as merging a large change, it waits for your approval.',
      ),
      say(
        'c5-c',
        'Some answers are worth keeping. You can add an answer to the ledger, which is the team’s shared memory, as a decision or a standing order. Every agent reads the standing orders at the start of its work.',
      ),
      say(
        'c5-d',
        'Many routine items never reach you at all. Your CEO agent handles them first. You will meet the CEO in a moment.',
      ),
    ],
  },
  {
    title: 'From an idea to a PRD: Discovery and the Boardroom',
    banner: 'Discovery and the Boardroom',
    cues: [
      say('c6-a', 'Sometimes you start with a rough idea, not a card. That is what Discovery is for.'),
      say(
        'c6-b',
        'You give the idea a title, and choose how the analyst should work. It can act as a facilitator, as a partner who challenges you, or as someone who ideates for you. The analyst asks questions, and you answer them. The requirements document, the PRD, takes shape in the draft panel as you go.',
      ),
      say(
        'c6-c',
        'When you are happy, the checklist checks the document, and you approve it. A business analyst then turns the approved PRD into cards.',
      ),
      say(
        'c6-d',
        'For a bigger question, use the Boardroom. Several personas, each with its own point of view, discuss the topic, and a chair keeps the discussion moving. The chair can pause the debate and ask you to decide.',
      ),
      say('c6-e', 'When the debate ends, you get the minutes. You can pull them straight into a PRD.'),
    ],
  },
  {
    title: 'Your agents, the CEO and the org chart',
    banner: 'Agents, the CEO and the org chart',
    cues: [
      say(
        'c7-a',
        'Hiring an agent takes a few choices: its role, its seniority, the runtime it uses, and the projects it may work on. You can pause an agent, resume it, or change its model.',
      ),
      say(
        'c7-b',
        'Every organization has one CEO agent, built in. The CEO watches the floor, handles routine items before they reach your desk, and writes you a daily report. You can talk to the CEO in a chat, and the CEO’s activity log lets you undo some of the actions it took.',
      ),
      say(
        'c7-c',
        'The org chart shows the whole team. You, your CEO, the business analysts, and the teams by department. Roles and workflows can be customized, too.',
      ),
    ],
  },
  {
    title: 'Workstations: your code stays on your machines',
    banner: 'Workstations',
    cues: [
      say(
        'c8-a',
        'The agents do their work on a workstation: a computer that you choose. It can be your own PC or Mac, a Linux machine, a Windows machine that runs WSL2, a server you rent, or a GitHub Codespace.',
      ),
      say(
        'c8-b',
        'A small program called the runner runs there. It connects out to Guildwise HQ, so no inbound port needs to be open on the workstation. Installing it is a single command that the app gives you.',
      ),
      say(
        'c8-c',
        'Your code, your passwords and your files stay on that machine. The Guildwise HQ server only keeps the board, the desk and the records. It never holds your repository credentials, or your provider keys.',
      ),
      say(
        'c8-d',
        'Each agent works in its own sandbox, in its own copy of the repository. On Linux, WSL2 and macOS, the operating system keeps an agent from reading anything outside its work.',
      ),
      say(
        'c8-e',
        'The workstation page shows you how many shifts run at once, and whether the machine is healthy.',
      ),
    ],
  },
  {
    title: 'Control: approvals, budgets and the audit log',
    banner: 'Control',
    cues: [
      say(
        'c9-a',
        'You decide how much the team may spend. Set a monthly budget for a project, or for the whole organization. The costs page shows where the money goes, by day, by project, by agent and by model.',
      ),
      say(
        'c9-b',
        'You also decide which steps need your approval. Merging and pushing can always wait for you.',
      ),
      say(
        'c9-c',
        'Every change in the organization is written to an audit log, which you can download as a spreadsheet.',
      ),
      say(
        'c9-d',
        'And the team has loop protection, so it cannot run away with your money or your patience.',
      ),
    ],
  },
  {
    title: 'Releases, environments and integrations',
    banner: 'Releases, environments, integrations',
    cues: [
      say(
        'c10-a',
        'When work is ready, it goes out through a release. Releases are queued, so you choose what goes live, and when. You can freeze all releases at once, and lift the freeze when you are ready.',
      ),
      say(
        'c10-b',
        'Environments describe where your app runs. Guildwise HQ can deploy your app to your own servers with Docker Compose. Before a deploy, it backs up the database, and if the new version is not healthy, it puts the previous one back.',
      ),
      say(
        'c10-c',
        'Your repositories can be on GitHub, GitLab, Azure DevOps or Bitbucket Cloud. Jira is available for tickets. You connect each one once, from the Integrations page.',
      ),
    ],
  },
  {
    title: 'Run it yourself, or let us host it',
    banner: 'Run it yourself, or let us host it',
    cues: [
      say(
        'c11-a',
        'Guildwise HQ is free and open source, under the Apache 2.0 license. You can run it yourself. You need a server, a domain name and an email relay. The guide walks you through the rest, with the commands.',
      ),
      say(
        'c11-b',
        'If you would rather not run a server, Guildwise Cloud hosts it for you. The price is on the pricing page, and support for setup and custom work is quoted separately.',
      ),
    ],
  },
  {
    title: 'Closing',
    banner: 'Closing',
    cues: [
      say(
        'c12-a',
        'That is Guildwise HQ. An organization of AI agents that you run on your own machines, with you in charge of every decision. It builds, reviews and tests your software out of the box, and it is ready for other work too.',
      ),
      say('c12-b', 'Thank you for watching.'),
    ],
  },
];

export const OUTRO: Cue[] = [];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];

/** The 55-second teaser (slug `overview-teaser`): the script's table, one passage per row. */
export const TEASER_CUES: Cue[] = [
  say('t1', 'What if your team of AI agents never did anything important without asking you first?'),
  say(
    't2',
    'This is Guildwise HQ. You describe the work as a card. Out of the box, agents specify it, build it, review it and test it, on your own machines.',
  ),
  say(
    't3',
    'When an agent needs a decision, it asks you on your desk. You answer once, and the team carries on.',
  ),
  say('t4', 'Start with a rough idea, and an analyst turns it into a requirements document you approve.'),
  say('t5', 'Your code stays on your workstations. The server never holds your keys.'),
  say('t6', 'Free and open source. Run it yourself, or let us host it.'),
];

export const TEASER_CHAPTERS: NarratedChapter[] = [
  { title: 'Teaser', banner: 'Guildwise HQ', cues: TEASER_CUES },
];
