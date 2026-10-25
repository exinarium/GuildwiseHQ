import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Releases video (slug `releases`, sidebar section 14). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Releases shows, for every project, what is waiting for you, what is live, and what was released.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Waiting for you',
    banner: 'Waiting for you',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Releases in the sidebar. Waiting for you lists the versions that are ready for a site.',
      },
      { id: 'c1-b', text: 'Release puts the version on the site, with the setup the Owner approved.' },
      { id: 'c1-c', text: 'Not now takes a version off the list. Nothing changes on that site.' },
    ],
  },
  {
    title: 'What is live and the history',
    banner: 'What is live',
    cues: [
      {
        id: 'c2-a',
        text: 'What is live shows the version on each site, since when, and where it runs. A site with nothing waiting offers Release the newest version on its project page.',
      },
      {
        id: 'c2-b',
        text: 'History lists every release, who asked for it and who released it. Filter it by project, site or result.',
      },
    ],
  },
  {
    title: 'Rules and the freeze',
    banner: 'Rules and freeze',
    cues: [
      {
        id: 'c3-a',
        text: 'Under Rules, the standard rule says what must be true before a version goes live. The advanced rule sets hold the details.',
      },
      {
        id: 'c3-b',
        text: 'Freeze all releases stops everything from going live. Lift the freeze when you are ready again.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Releases: one place to decide what goes live, and to see what is waiting to go out. Open any release to read what it contains.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
