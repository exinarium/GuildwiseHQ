import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Backlog video (slug `backlog`, sidebar section 2). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'The backlog is where wanted work waits before it becomes a card. Nothing here is worked on until you send it to your business analyst.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Open the backlog and add ideas',
    banner: 'Add ideas quickly',
    cues: [
      { id: 'c1-a', text: 'Open Backlog in the sidebar. Each project keeps its own list.' },
      {
        id: 'c1-b',
        text: 'To add an idea, type a title and press Enter. It lands at the top, with normal priority.',
      },
    ],
  },
  {
    title: 'Flag, sort and drop',
    banner: 'Flag, sort and drop',
    cues: [
      { id: 'c2-a', text: 'Click the star to flag what matters most.' },
      {
        id: 'c2-b',
        text: 'Sort by Newest to see what was added last.',
      },
      {
        id: 'c2-s',
        text: 'The search box finds an item by its title, its description or a tag, and the filters narrow the list by priority or by who suggested it.',
      },
      {
        id: 'c2-c',
        text: 'An idea that is no longer wanted can be dropped from its actions menu. You can still find it with the Dropped filter.',
      },
    ],
  },
  {
    title: 'Send it to the BA',
    banner: 'Choose what to send',
    cues: [
      {
        id: 'c3-a',
        text: 'To start work, tick the items you want and choose Send to the BA. Owners and Admins can edit the backlog, and everyone on the project can read it.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is the backlog. Keep ideas here as long as you like, and send them on to your business analyst when you are ready. Even dropped ideas can still be found again.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
