import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Costs video (slug `costs`, sidebar section 17). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Costs shows what your agents cost, worked out from the tokens every shift used, and what they delivered for it.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Range and total spend',
    banner: 'Range and total spend',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Costs in the sidebar. Only Owners and Admins see it. Choose a range: this month, the last 30 days or last month, or pick your own dates and a project.',
      },
      {
        id: 'c1-b',
        text: 'Total spend sums every shift in the range, and By day charts it day by day.',
      },
    ],
  },
  {
    title: 'By project, agent and model',
    banner: 'Where the money goes',
    cues: [
      {
        id: 'c2-a',
        text: 'By project splits the spend per project. The meter shows how much of this month’s budget a project has used: the web shop is at about eighty percent. The project name opens its settings, where the budget is set.',
      },
      {
        id: 'c2-c',
        text: 'By agent and By model show who used the tokens, and on which model.',
      },
    ],
  },
  {
    title: 'What the agents delivered',
    banner: 'What the agents delivered',
    cues: [
      {
        id: 'c3-a',
        text: 'What the agents delivered puts the cost next to the work: cards finished, an estimate of the hours a person would have needed, and how that compares with last month.',
      },
    ],
  },
  {
    title: 'Export and currency',
    banner: 'Export and currency',
    cues: [
      {
        id: 'c4-a',
        text: 'Export CSV downloads every shift in the range for your own spreadsheet. Under Currency and prices you set the currency and its rate, and see the list prices used.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is the Costs page: see what the work costs, and keep each project within its budget.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
