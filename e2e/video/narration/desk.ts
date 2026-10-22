import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Desk video (slug `desk`, sidebar section 5). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'The desk is where your agents ask you things: questions, approvals and heads-ups. Answer them, and the work moves on.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Open the desk',
    banner: 'Open the desk',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Desk in the sidebar. The number next to it shows how many items are waiting for you.',
      },
      {
        id: 'c1-b',
        text: 'Items are grouped by what needs you most: Needs you first at the top, then heads-ups, and the decisions your CEO took at the end.',
      },
    ],
  },
  {
    title: 'Filters',
    banner: 'Filter the desk',
    cues: [
      {
        id: 'c2-a',
        text: 'The chips filter the list. Blocking shows only what holds up cards. Questions and Approvals show one kind each.',
      },
      {
        id: 'c2-b',
        text: 'All brings everything back.',
      },
    ],
  },
  {
    title: 'Answer a question',
    banner: 'Answer a question',
    cues: [
      {
        id: 'c3-a',
        text: 'Each question says who asked, what they were doing, and the options. Pick one, or type your own answer.',
      },
      {
        id: 'c3-b',
        text: 'Add to ledger as decides how your answer is kept. A standing order for this project means agents follow it from now on, without asking again.',
      },
    ],
  },
  {
    title: 'Accept a recommendation',
    banner: 'Accept a recommendation',
    cues: [
      {
        id: 'c4-a',
        text: 'Your CEO reads the desk too. Here it recommends an answer, with its reason and how sure it is.',
      },
      {
        id: 'c4-b',
        text: 'If you agree, choose Accept recommendation, and the answer goes out at once.',
      },
    ],
  },
  {
    title: 'What the CEO handled',
    banner: 'What the CEO handled',
    cues: [
      {
        id: 'c5-a',
        text: 'Handled by CEO shows what your CEO settled on its own, also the items you have already reviewed.',
      },
      {
        id: 'c5-b',
        text: 'CEO decisions lists the ones still waiting for your review: what was asked, what it decided and why. Acknowledge it, or correct it so the CEO learns.',
      },
    ],
  },
  {
    title: 'The daily report',
    banner: 'The daily report',
    cues: [
      {
        id: 'c6-a',
        text: 'Every morning the CEO leaves a Daily report: what needs you, and everything it decided or recommended in the last 24 hours, with a Correct button on each decision.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is the desk. Visit it once or twice a day, and your agents never wait long.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
