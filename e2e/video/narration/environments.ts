import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Environments video (slug `environments`, sidebar section 3). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Environments is where your app runs: the test site your team tries, the live site your customers use, and the computers they run on.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Your app: how to start it',
    banner: 'Your app',
    cues: [
      { id: 'c1-a', text: 'Open Environments in the sidebar. Each project has its own page.' },
      {
        id: 'c1-b',
        text: 'Your app says how to start the app. DevOps has looked at the project and has a suggestion. Review it.',
      },
      {
        id: 'c1-c',
        text: 'Answer its question, then press Use these steps. Test copies of cards use the same steps.',
      },
    ],
  },
  {
    title: 'The test site and the live site',
    banner: 'Test site and live site',
    cues: [
      {
        id: 'c2-a',
        text: 'Each environment shows where it runs, its address, the version that runs, and when it updates. The test site updates by itself after each merge.',
      },
      {
        id: 'c2-b',
        text: 'The live site changes only when you say so. With nothing waiting, Release the newest version puts the latest approved version live. A database backup is taken first.',
      },
    ],
  },
  {
    title: 'Places',
    banner: 'Places',
    cues: [
      {
        id: 'c3-a',
        text: 'Places lists the computers and servers this project uses, and what uses them. Check looks at a computer again. Nothing is changed.',
      },
      {
        id: 'c3-b',
        text: 'A server is reached from one of your computers. Reconnect signs in again, and you choose which computer does it.',
      },
    ],
  },
  {
    title: 'Add an environment',
    banner: 'Add an environment',
    cues: [
      {
        id: 'c4-a',
        text: 'Add an environment asks what it is for and where it runs, then shows the app it found there.',
      },
      {
        id: 'c4-b',
        text: 'Nothing is saved before the review. When Save is off, it always says why. Here, Docker Compose is missing on that computer.',
      },
    ],
  },
  {
    title: 'Pause releases',
    banner: 'The Releases switch',
    cues: [
      {
        id: 'c5-a',
        text: 'What you started stays as a draft. At the top, the Releases switch pauses releases and automatic updates. Nothing that runs is stopped.',
      },
      { id: 'c5-b', text: 'Turn it on again when you are ready.' },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Environments: set up where your app runs once, and release when you are ready.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
