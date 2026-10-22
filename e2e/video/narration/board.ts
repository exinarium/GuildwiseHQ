import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Board video (slug `board`, sidebar section 1). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'The board shows every card of a project, in the stages of its workflow. Cards move by themselves as your agents work.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Read the board',
    banner: 'Read the board',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Board in the sidebar. Each column is a stage of the workflow, from Spec on the left to Done on the right.',
      },
      {
        id: 'c1-b',
        text: 'The header counts the open and blocked cards and shows what the project spent this month. Each card shows what it has cost so far.',
      },
    ],
  },
  {
    title: 'Filter what needs you',
    banner: 'Filter what needs you',
    cues: [
      {
        id: 'c2-a',
        text: 'The chips narrow the board. Blocked shows only the cards that wait for your answer at the desk.',
      },
      {
        id: 'c2-b',
        text: 'Waiting for my approval shows the cards you must approve. Waiting for my QA shows the ones you test before they are done.',
      },
    ],
  },
  {
    title: 'Open a card',
    banner: 'Open a card',
    cues: [
      {
        id: 'c3-a',
        text: 'Click a card to open it. This one is blocked: its builder asked a question, and the card waits for your answer.',
      },
      {
        id: 'c3-b',
        text: 'The brief says what to build: context, requirements and acceptance criteria. The details show its stage and risk.',
      },
      {
        id: 'c3-c',
        text: 'Further down, the thread holds the conversation, with the question itself, and the handoffs record every shift: which agent did it, and the outcome.',
      },
    ],
  },
  {
    title: 'New card, pause and archive',
    banner: 'New card, pause, archive',
    cues: [
      {
        id: 'c4-a',
        text: 'New card opens the form: a title, the repository and the brief. Cancel takes you back to the board.',
      },
      {
        id: 'c4-b',
        text: 'Pause project stops new work from starting. Running shifts finish, and Resume project picks up where it left off.',
      },
      {
        id: 'c4-c',
        text: 'Finished cards leave the board a day later. Archive lists them, and you can open or reopen any of them.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is the board. Check the chips each day, and open a card whenever you want the full story.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
