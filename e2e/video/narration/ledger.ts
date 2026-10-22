import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Ledger video (slug `ledger`, sidebar section 19). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'The Ledger keeps the requirements, decisions and standing orders your agents rely on, so nobody has to ask the same question twice.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Search and filter',
    banner: 'Search the ledger',
    cues: [
      { id: 'c1-a', text: 'Open Ledger in the sidebar. Search finds an entry by the words in it.' },
      {
        id: 'c1-b',
        text: 'The chips show only standing orders, decisions or requirements, and the Project filter narrows the list to one project.',
      },
    ],
  },
  {
    title: 'Add a standing order',
    banner: 'Add entry',
    cues: [
      {
        id: 'c2-a',
        text: 'Choose Add entry. A standing order is loaded by every agent. Leave the project blank and it applies to every project. Requirements and decisions always belong to one project.',
      },
      {
        id: 'c2-b',
        text: 'Give it a title and the text, then choose Add to ledger. Every agent loads the new order from its next shift or chat.',
      },
    ],
  },
  {
    title: 'Edit and history',
    banner: 'Edit and history',
    cues: [
      {
        id: 'c3-a',
        text: 'A standing order can be edited. Agents get the new wording from their next shift, and the earlier wording stays in its history. History shows every version, who saved it, and when.',
      },
    ],
  },
  {
    title: 'Retire an entry',
    banner: 'Retire and Show retired',
    cues: [
      {
        id: 'c4-a',
        text: 'An entry that no longer applies is retired, with a reason. Agents stop seeing it, and a search no longer finds it.',
      },
      {
        id: 'c4-b',
        text: 'Show retired brings retired entries back into view, greyed out, for the record.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is the Ledger: what your agents know, in one place you can search and correct.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
