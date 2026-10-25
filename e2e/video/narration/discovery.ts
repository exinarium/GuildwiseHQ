import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Discovery video (slug `discovery`). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Discovery turns a rough idea into a product brief or a PRD. An analyst interviews you one question at a time, and you decide what goes into the document.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Start a discovery',
    banner: 'New discovery',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Discovery in the sidebar and click New discovery. Give it a title, a starting idea, and the project it is for.',
      },
      {
        id: 'c1-b',
        text: 'How should the analyst work? As a Facilitator it only asks. As a Partner it also brings its own ideas, labelled as its own. Or choose Ideate for me.',
      },
      {
        id: 'c1-c',
        text: 'If your organization has a CEO, you can work with the CEO. It proposes an answer to each question, or prepares all the answers first for you to review. You always have the last word.',
      },
      {
        id: 'c1-d',
        text: 'A time limit works like a meeting, and a cost limit stops the session when it is used up. Click Start.',
      },
    ],
  },
  {
    title: 'Answer the questions',
    banner: 'One question at a time',
    cues: [
      {
        id: 'c2-a',
        text: 'The analyst asks the first question. Pick a quick answer, or write your own words, skip it, or park it for later.',
      },
      {
        id: 'c2-b',
        text: 'The phases run from Frame through Diverge, Converge and Stress test to Capture. The panel on the right collects ideas, assumptions, open questions and decisions as you go.',
      },
      {
        id: 'c2-c',
        text: 'Sometimes the analyst makes a proposal. Nothing changes until you choose Apply. Reject drops it, and Redirect sends your own words back.',
      },
    ],
  },
  {
    title: 'Approve and hand over',
    banner: 'From idea to PRD',
    cues: [
      {
        id: 'c3-a',
        text: 'In Capture the analyst writes the PRD from the panel. Validate against the checklist shows what is still missing.',
      },
      {
        id: 'c3-b',
        text: 'Approve it, then Hand to BA. The business analyst gets an intake linked to the PRD and drafts the cards from it.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'You can pause a discovery at any time and come back the next day. Nothing is lost.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
