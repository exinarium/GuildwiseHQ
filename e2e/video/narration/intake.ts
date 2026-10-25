import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Intake video (slug `intake`, sidebar section 6). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Intake brings work in from Jira or GitHub. Your business analyst reads the ticket and turns it into cards.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'One ticket',
    banner: 'Bring in one ticket',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Intake in the sidebar. Paste a ticket key, an issue link, or just describe what you need. The page shows what it detected.',
      },
      {
        id: 'c1-b',
        text: 'Tell your CEO hands it to your CEO in its chat, and the CEO takes it from there. Work with the BA directly opens a conversation with your business analyst.',
      },
    ],
  },
  {
    title: 'The chat with the BA',
    banner: 'Talk it through with the BA',
    cues: [
      {
        id: 'c2-a',
        text: 'The BA reads the ticket and maps it to a project. It asks only what it cannot decide.',
      },
      {
        id: 'c2-b',
        text: 'Nothing was missing here, so it drafted the card straight away. It is listed on the right, ready for the team.',
      },
    ],
  },
  {
    title: 'A batch of tickets',
    banner: 'Bring in a batch',
    cues: [
      {
        id: 'c3-a',
        text: 'For many tickets at once, switch to Batch. Paste one ticket per line, and choose a project or let the BA decide.',
      },
      {
        id: 'c3-b',
        text: 'The BA works through the batch in the background, and asks on the desk when it is stuck.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'Earlier intakes and batches stay listed on the Intake page, so you can pick any conversation up again whenever you need to.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
