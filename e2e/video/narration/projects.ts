import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Projects video (slug `projects`, sidebar section 8). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Projects lists everything your organization works on, in the order your agents serve it.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'A new project',
    banner: 'A new project',
    cues: [
      { id: 'c1-a', text: 'Open Projects in the sidebar.' },
      {
        id: 'c1-b',
        text: 'New project asks for a name, a short key that card references start with, and a workflow. Code builds features from repositories.',
      },
    ],
  },
  {
    title: 'The priority order',
    banner: 'The priority order',
    cues: [
      {
        id: 'c2-a',
        text: 'The project at the top is served first: agents take the next card from the highest project that has work. Drag a project, or use its arrows, to move it up.',
      },
    ],
  },
  {
    title: 'Project settings',
    banner: 'Project settings',
    cues: [
      {
        id: 'c3-a',
        text: 'The gear opens the project settings. The chips at the top jump straight to a section.',
      },
      {
        id: 'c3-b',
        text: 'Under Repos, add the repository the agents work in: its address and a name. The DevOps engineer then clones it onto your computers.',
      },
    ],
  },
  {
    title: 'Budget and team',
    banner: 'Budget and team',
    cues: [
      {
        id: 'c4-a',
        text: 'Set a monthly budget. At eighty percent you are warned, and at the limit nothing new starts until you raise it or override it for the month.',
      },
      {
        id: 'c4-b',
        text: 'Under Team, invite someone who has a Guildwise account by email, with Send invitation. They show as pending until they accept, and then help manage this project.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'Back on Projects, the new project has its place in the order. That is Projects.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
