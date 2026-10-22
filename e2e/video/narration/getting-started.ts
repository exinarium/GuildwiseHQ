import type { Cue, NarratedChapter } from './types.ts';

/**
 * The voice-over of the getting-started video (slug `getting-started`): warm, clear, second person. It follows the
 * plan entry G in docs/guide/VIDEO-PLAN.md: the Get started checklist, a workstation, a project and its repository, the
 * lean team, a card from the sidebar button, a talk with the business analyst, answering on the Desk, the board moving
 * by itself, and where Help and Ctrl K are.
 */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Welcome to Guildwise HQ. In under three minutes, you go from an empty organization to a team of AI agents at work.',
    speech:
      'Welcome to Guildwise H Q. In under three minutes, you go from an empty organization to a team of A I agents at work.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'The Get started checklist',
    banner: 'Get started',
    cues: [
      {
        id: 'c1-a',
        text: 'A new organization shows Get started in the sidebar. It lists what is left: a project, its repository, a workstation, your team, and a first talk with the business analyst. Each step ticks itself off.',
      },
    ],
  },
  {
    title: 'Add a workstation',
    banner: 'Add a workstation',
    cues: [
      {
        id: 'c2-a',
        text: 'A workstation is the computer that runs your agents. Open Workstations, and choose Add a workstation.',
      },
      {
        id: 'c2-b',
        text: "The guide asks where your agents run, gives you one command to copy, and shows the progress live. Here, Alex's laptop is already paired and online.",
      },
    ],
  },
  {
    title: 'Create a project',
    banner: 'Create a project and its repository',
    cues: [
      {
        id: 'c3-a',
        text: 'Next, open Projects and choose New project. Give it a name and a short key. The key goes in front of every card number.',
      },
      { id: 'c3-b', text: 'Then, in the project settings, add the repository where the code lives.' },
    ],
  },
  {
    title: 'Hire a lean team',
    banner: 'Hire a lean team',
    cues: [
      {
        id: 'c4-a',
        text: 'Now hire your team. On Agents, choose Hire agent, pick a role, and keep this project selected under Where may this agent work.',
      },
      {
        id: 'c4-b',
        text: 'A lean team has seven roles: a business analyst, a planner, an architect, a builder, a pre-reviewer, a reviewer and a tester.',
      },
      {
        id: 'c4-c',
        text: 'Together they plan, design, build and check every change before it reaches your main code.',
      },
    ],
  },
  {
    title: 'Create a card and talk to the BA',
    banner: 'New card, and a talk with the BA',
    cues: [
      {
        id: 'c5-a',
        text: 'To ask for work, use New card at the top of the sidebar. Give it a title, say what you need and how you will know it is done, then choose Specify.',
      },
      {
        id: 'c5-b',
        text: 'You can also just talk to your business analyst. Open the chat, pick Bea, and ask in plain words.',
      },
      { id: 'c5-c', text: 'She answers like a colleague, and can turn the conversation into cards.' },
    ],
  },
  {
    title: 'Answer on the Desk',
    banner: 'Answer on the Desk',
    cues: [
      {
        id: 'c6-a',
        text: 'When an agent needs a decision, it lands on the Desk, and the number in the sidebar tells you.',
      },
      { id: 'c6-b', text: 'Pick an option and choose Answer. The count drops, and the agent carries on.' },
    ],
  },
  {
    title: 'Watch the board',
    banner: 'The card moves by itself',
    cues: [
      {
        id: 'c7-a',
        text: 'On the Board, the card moves from column to column by itself, as the agents plan, design, build, review and test.',
      },
    ],
  },
  {
    title: 'Help and shortcuts',
    banner: 'Help, the tour and Ctrl K',
    cues: [
      {
        id: 'c8-a',
        text: 'Help is at the bottom of the sidebar, with the articles, the glossary and the guided tour. And Ctrl K jumps anywhere.',
        speech:
          'Help is at the bottom of the sidebar, with the articles, the glossary and the guided tour. And Control K jumps anywhere.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is all it takes. Thank you for watching, and enjoy your new team.',
  },
];

/** What the recording types into the BA chat, and the answer the recording-only mock reply map gives to it. */
export const BA_QUESTION = 'What would you add to the shop next?';
export const BA_ANSWER =
  'Good question. Once the welcome banner is in, I would add three things:\n\n' +
  '1. A search box, so visitors find a product in seconds.\n' +
  '2. Customer reviews on each product page, which builds trust.\n' +
  '3. A simple order-confirmation email.\n\n' +
  'Shall I turn these into cards for the team? I would start with the search box.';

/** The planner's question on the Desk (the mock agent asks a fixed sentence; the spec gives it these words). */
export const DESK_QUESTION = {
  title: 'Should the welcome banner show on every page, or only on the home page?',
  body: 'The card says "on the home page", but visitors often land on a product page first.',
  doing: 'Planning the welcome banner',
  options: [
    ['Only on the home page', 'As the card says'],
    ['On every page', 'Also greets visitors who land on a product page'],
  ] as Array<[string, string]>,
  recommend: 0,
};

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
