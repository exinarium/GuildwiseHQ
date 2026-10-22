import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Research video (slug `research`, sidebar section 4). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Research answers questions with sources. A researcher gathers and writes, a checker verifies every claim against its source, and only then is the note published.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Ask a question',
    banner: 'Ask a question',
    cues: [
      { id: 'c1-a', text: 'Open Research in the sidebar of a research project.' },
      {
        id: 'c1-b',
        text: 'New research card opens the card form. Give it a title, write the question the way you would ask a colleague, choose how deep to dig, and press Specify.',
      },
    ],
  },
  {
    title: 'In progress',
    banner: 'In progress',
    cues: [
      {
        id: 'c2-a',
        text: 'Back on Research, In progress lists the open research cards and the stage each one is in. A blocked card waits for your answer on the desk.',
      },
    ],
  },
  {
    title: 'Published notes',
    banner: 'Published notes',
    cues: [
      {
        id: 'c3-a',
        text: 'Published notes are the answers that passed the fact check, with a preview and every citation. Each citation links to its source.',
      },
      {
        id: 'c3-b',
        text: "Each note is kept as a file in the project's vault folder, at the path under its title, so your team and your agents can find it later.",
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  { id: 'outro-1', text: 'That is Research: ask a question, and get a checked answer with its sources.' },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
